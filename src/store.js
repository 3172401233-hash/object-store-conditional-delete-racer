import { createHash } from 'node:crypto';

export class StoreError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'StoreError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 版本化对象存储的本地内存模型。
 *
 * 原子性保证：每个公开操作（put / deleteObject / get）都是一次同步调用，
 * 条件检查与状态变更在同一个不可中断的步骤内完成。Node.js 单线程模型下，
 * 不存在“检查通过后被其他写入插队”的窗口，因此 If-Match 条件删除是原子的。
 */
export class VersionedObjectStore {
  #objects = new Map();
  #sequence = 0;
  #opLog = [];
  #now;
  #defaultRetentionMs;

  constructor({ now, defaultRetentionMs } = {}) {
    this.#now = now ?? (() => Date.now());
    this.#defaultRetentionMs = defaultRetentionMs ?? 0;
  }

  #versionsOf(key) {
    let versions = this.#objects.get(key);
    if (!versions) {
      versions = [];
      this.#objects.set(key, versions);
    }
    return versions;
  }

  #makeEtag(data) {
    const hash = createHash('sha256')
      .update(String(data))
      .update(String(this.#sequence))
      .digest('hex')
      .slice(0, 16);
    return `"${hash}"`;
  }

  #record(op, key, detail) {
    this.#opLog.push({ seq: this.#sequence, op, key, ...detail });
  }

  currentVersion(key) {
    const versions = this.#objects.get(key);
    return versions && versions.length > 0 ? versions[versions.length - 1] : null;
  }

  listVersions(key) {
    return (this.#objects.get(key) ?? []).map((v) => ({ ...v }));
  }

  get opLog() {
    return this.#opLog.map((entry) => ({ ...entry }));
  }

  put(key, data, { retentionUntil } = {}) {
    this.#sequence += 1;
    const version = {
      versionId: `v${this.#sequence}`,
      etag: this.#makeEtag(data),
      data,
      isDeleteMarker: false,
      createdAt: this.#now(),
      retentionUntil:
        retentionUntil ??
        (this.#defaultRetentionMs > 0 ? this.#now() + this.#defaultRetentionMs : null),
    };
    this.#versionsOf(key).push(version);
    this.#record('put', key, {
      versionId: version.versionId,
      etag: version.etag,
    });
    return { key, versionId: version.versionId, etag: version.etag };
  }

  get(key) {
    const current = this.currentVersion(key);
    if (!current || current.isDeleteMarker) {
      throw new StoreError(404, 'NoSuchKey', `对象不存在或已被删除: ${key}`);
    }
    return {
      key,
      data: current.data,
      etag: current.etag,
      versionId: current.versionId,
    };
  }

  /**
   * 条件删除。条件求值、保留检查、写入删除标记在同一同步步骤内完成。
   *
   * 确定行为：
   * - ifMatch 提供且不等于当前 ETag（可为 "*" 匹配任意现存版本）→ 412；
   * - 当前版本处于保留期内 → 409；
   * - 对象不存在或当前版本已是删除标记 → 幂等 204 already-deleted，不产生新版本；
   * - ifMatch 省略 → 无条件删除当前版本（保留策略仍然生效）。
   */
  deleteObject(key, { ifMatch } = {}) {
    this.#sequence += 1;
    const current = this.currentVersion(key);

    if (!current || current.isDeleteMarker) {
      this.#record('delete', key, { result: 'already-deleted' });
      return { key, status: 204, result: 'already-deleted' };
    }

    if (ifMatch !== undefined) {
      const matches = ifMatch === '*' || ifMatch === current.etag;
      if (!matches) {
        this.#record('delete', key, {
          result: 'precondition-failed',
          checkedEtag: ifMatch,
          currentEtag: current.etag,
        });
        throw new StoreError(
          412,
          'PreconditionFailed',
          `If-Match ${ifMatch} 与当前 ETag ${current.etag} 不一致`,
        );
      }
    }

    if (current.retentionUntil !== null && this.#now() < current.retentionUntil) {
      this.#record('delete', key, {
        result: 'retention-blocked',
        versionId: current.versionId,
        retentionUntil: current.retentionUntil,
      });
      throw new StoreError(
        409,
        'ObjectLocked',
        `版本 ${current.versionId} 处于保留期至 ${current.retentionUntil}`,
      );
    }

    const marker = {
      versionId: `v${this.#sequence}`,
      etag: null,
      data: null,
      isDeleteMarker: true,
      createdAt: this.#now(),
      retentionUntil: null,
    };
    this.#versionsOf(key).push(marker);
    this.#record('delete', key, {
      result: 'deleted',
      checkedEtag: ifMatch ?? null,
      deletedVersionId: current.versionId,
      deleteMarkerVersionId: marker.versionId,
    });
    return {
      key,
      status: 204,
      result: 'deleted',
      deletedVersionId: current.versionId,
      deleteMarkerVersionId: marker.versionId,
    };
  }

  /**
   * 按给定顺序应用一组操作，返回每个操作的结果（不中断后续操作）。
   * 用于以确定的交错顺序模拟并发客户端。
   */
  run(operations) {
    return operations.map((op) => {
      try {
        switch (op.op) {
          case 'put':
            return { ok: true, value: this.put(op.key, op.data, op) };
          case 'delete':
            return { ok: true, value: this.deleteObject(op.key, op) };
          case 'get':
            return { ok: true, value: this.get(op.key) };
          default:
            throw new StoreError(400, 'BadRequest', `未知操作: ${op.op}`);
        }
      } catch (err) {
        if (err instanceof StoreError) {
          return { ok: false, statusCode: err.statusCode, code: err.code, message: err.message };
        }
        throw err;
      }
    });
  }
}
