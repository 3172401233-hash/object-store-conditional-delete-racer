# object-store-conditional-delete-racer

用 Node.js 24 模拟版本化对象存储的条件删除：处理带版本条件（If-Match / ETag）的删除、更新竞争、删除标记和保留策略。

## 本地模型

**所有操作均在本地内存模型中完成**（`src/store.js` 的 `VersionedObjectStore`），不访问网络、磁盘或真实对象存储。每个对象是一串版本，每次 `put` 追加一个带唯一 ETag 的新版本，删除则追加一个删除标记版本。

## 原子性

条件检查与状态变更在**同一个同步步骤**内完成，而不是"先检查、后删除"两步。Node.js 单线程模型下同步代码不可被交错打断，因此不存在"检查通过后、删除执行前被并发写入插队"的窗口——这正是真实系统中条件检查和删除分成两步会导致新数据被误删的根源。并发客户端通过操作的交错顺序来模拟（见 `run()`），每个操作的结果由其在序列中的位置唯一确定。

## 操作语义

| 场景 | 行为 |
| --- | --- |
| `put(key, data)` | 追加新版本，返回 `{ versionId, etag }` |
| `deleteObject(key, { ifMatch })` 且 ETag 匹配 | 追加删除标记，返回 204 `deleted` |
| `ifMatch` 为旧 ETag（已被并发写入覆盖） | 抛出 412 `PreconditionFailed`，新数据保留 |
| `ifMatch: '*'` | 匹配任意现存版本 |
| 省略 `ifMatch`（条件缺失） | 无条件删除当前版本（保留策略仍生效） |
| 当前版本在保留期内（`retentionUntil`） | 抛出 409 `ObjectLocked`，版本保留 |
| 重复删除 / 删除不存在的键 | 幂等返回 204 `already-deleted`，不产生新版本 |
| `get` 已删除或不存在的键 | 抛出 404 `NoSuchKey` |

每次操作都会向 `store.opLog` 追加一条原子记录（含检查的 ETag、被删版本 ID 等），可用于审计交错执行的结果。

## 运行测试

```sh
node --test   # 或 npm test
```

测试（`test/store.test.js`，基于 `node:test`）覆盖：旧 ETag 拒绝、并发覆盖下的原子删除、删除标记与重复删除幂等、保留期阻止删除、条件缺失的确定行为、操作日志一致性。
