import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionedObjectStore, StoreError } from '../src/store.js';

test('旧 ETag 的条件删除被拒绝，新版本数据保留', () => {
  const store = new VersionedObjectStore();
  const v1 = store.put('doc', 'old-content');
  const v2 = store.put('doc', 'new-content');

  assert.throws(
    () => store.deleteObject('doc', { ifMatch: v1.etag }),
    (err) => err instanceof StoreError && err.statusCode === 412 && err.code === 'PreconditionFailed',
  );

  const current = store.get('doc');
  assert.equal(current.data, 'new-content');
  assert.equal(current.etag, v2.etag);
  assert.equal(store.listVersions('doc').length, 2);
});

test('并发覆盖：读 ETag 后被他人写入，删除原子失败', () => {
  const store = new VersionedObjectStore();
  store.put('doc', 'v1');

  // 客户端 A 读取当前 ETag，准备条件删除
  const etagSeenByA = store.get('doc').etag;
  // 客户端 B 在 A 删除前写入了新版本
  const byB = store.put('doc', 'v2-by-B');
  // A 携带旧 ETag 删除：检查与删除在同一步骤内，必然失败而不是误删
  assert.throws(
    () => store.deleteObject('doc', { ifMatch: etagSeenByA }),
    (err) => err.statusCode === 412,
  );

  assert.equal(store.get('doc').data, 'v2-by-B');
  // A 改用最新 ETag 后删除成功
  const result = store.deleteObject('doc', { ifMatch: byB.etag });
  assert.equal(result.result, 'deleted');
  assert.equal(result.deletedVersionId, byB.versionId);
});

test('run() 以确定顺序应用交错操作', () => {
  const store = new VersionedObjectStore();
  const seeded = store.put('doc', 'v1');

  const results = store.run([
    { op: 'put', key: 'doc', data: 'v2-concurrent' },
    { op: 'delete', key: 'doc', ifMatch: seeded.etag },
    { op: 'get', key: 'doc' },
  ]);

  assert.equal(results[0].ok, true);
  assert.deepEqual(
    { ok: results[1].ok, statusCode: results[1].statusCode, code: results[1].code },
    { ok: false, statusCode: 412, code: 'PreconditionFailed' },
  );
  assert.equal(results[2].value.data, 'v2-concurrent');
});

test('删除标记：删除后 get 为 404，重复删除幂等且不产生新版本', () => {
  const store = new VersionedObjectStore();
  store.put('doc', 'content');

  const first = store.deleteObject('doc');
  assert.equal(first.result, 'deleted');
  assert.ok(first.deleteMarkerVersionId);

  const current = store.currentVersion('doc');
  assert.equal(current.isDeleteMarker, true);
  assert.throws(() => store.get('doc'), (err) => err.statusCode === 404);

  const versionsBefore = store.listVersions('doc').length;
  const second = store.deleteObject('doc');
  assert.deepEqual(
    { status: second.status, result: second.result },
    { status: 204, result: 'already-deleted' },
  );
  assert.equal(store.listVersions('doc').length, versionsBefore);

  // 删除标记之上可以重新写入
  const revived = store.put('doc', 'revived');
  assert.equal(store.get('doc').etag, revived.etag);
});

test('保留策略：保留期内删除被 409 阻止，过期后放行', () => {
  let now = 1_000;
  const store = new VersionedObjectStore({ now: () => now });
  store.put('doc', 'locked', { retentionUntil: 5_000 });

  assert.throws(
    () => store.deleteObject('doc'),
    (err) => err.statusCode === 409 && err.code === 'ObjectLocked',
  );
  assert.equal(store.get('doc').data, 'locked');

  now = 5_000;
  const result = store.deleteObject('doc');
  assert.equal(result.result, 'deleted');
});

test('条件缺失：省略 If-Match 时无条件删除当前版本', () => {
  const store = new VersionedObjectStore();
  store.put('doc', 'v1');
  store.put('doc', 'v2');

  const result = store.deleteObject('doc');
  assert.equal(result.result, 'deleted');
  assert.equal(store.currentVersion('doc').isDeleteMarker, true);
});

test('If-Match "*" 匹配任意现存版本，不存在的键返回 404', () => {
  const store = new VersionedObjectStore();
  store.put('doc', 'content');

  const result = store.deleteObject('doc', { ifMatch: '*' });
  assert.equal(result.result, 'deleted');

  assert.throws(() => store.get('missing'), (err) => err.statusCode === 404);
  const repeat = store.deleteObject('missing');
  assert.equal(repeat.result, 'already-deleted');
});

test('操作日志：每次删除是单条原子记录，检查的 ETag 与被删版本一致', () => {
  const store = new VersionedObjectStore();
  const v1 = store.put('doc', 'v1');
  store.put('doc', 'v2');

  assert.throws(() => store.deleteObject('doc', { ifMatch: v1.etag }));
  const v2 = store.get('doc');
  store.deleteObject('doc', { ifMatch: v2.etag });

  const deletes = store.opLog.filter((e) => e.op === 'delete');
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].result, 'precondition-failed');
  assert.equal(deletes[1].result, 'deleted');
  assert.equal(deletes[1].checkedEtag, v2.etag);

  const versions = store.listVersions('doc');
  const deleted = versions.find((v) => v.versionId === deletes[1].deletedVersionId);
  assert.equal(deleted.etag, deletes[1].checkedEtag);
});
