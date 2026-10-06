import { Router } from 'express';
import { z } from 'zod';
import { createRelationshipSchema, rollbackRelationshipSchema, updateRelationshipSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { badRequest } from '../http/errors';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as kinship from '../services/kinshipService';
import { auditKinshipExport, renderKinshipExport, type KinshipExportFormat } from '../services/kinshipExportService';

export const kinshipRouter = Router({ mergeParams: true });

const persistSchema = z.object({
  fromPersonId: z.string().cuid(),
  toPersonId: z.string().cuid(),
  kind: z.enum(['parent', 'spouse', 'sibling', 'kin']),
  label: z.string().trim().max(40).optional().nullable(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(300).optional(),
  basis: z.unknown().optional(),
  adopt: z.boolean().default(false),
});

const persistAllSchema = z.object({
  adopt: z.boolean().default(false),
  items: z
    .array(
      z.object({
        fromPersonId: z.string().cuid(),
        toPersonId: z.string().cuid(),
        kind: z.enum(['parent', 'spouse', 'sibling', 'kin']),
        label: z.string().trim().max(40).optional().nullable(),
        confidence: z.number().min(0).max(1).optional(),
        reason: z.string().max(300).optional(),
        basis: z.unknown().optional(),
      }),
    )
    .max(500),
});

/** 图谱：人物 + 全部边 + 实时矛盾检测结果 */
kinshipRouter.get(
  '/graph',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ graph: await kinship.getGraph(ctx) });
  }),
);

/** 从物品共现与称谓推导候选关系（只读，不改图谱） */
kinshipRouter.get(
  '/infer',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await kinship.inferSuggestions(ctx));
  }),
);

/** 采纳/暂存单条建议 */
kinshipRouter.post(
  '/infer/persist',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(persistSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const edge = await kinship.persistSuggestion(user.id, ctx, req.body, req.body.adopt, clientMeta(req));
    res.status(201).json({ relationship: edge });
  }),
);

/** 批量采纳/暂存建议 */
kinshipRouter.post(
  '/infer/persist-all',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(persistAllSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await kinship.persistAllSuggestions(user.id, ctx, req.body.items, req.body.adopt, clientMeta(req));
    res.status(201).json(result);
  }),
);

/** 版本列表 */
kinshipRouter.get(
  '/versions',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ versions: await kinship.listVersions(ctx) });
  }),
);

/** 单个版本快照 */
kinshipRouter.get(
  '/versions/:version',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version <= 0) throw badRequest('版本号不合法');
    res.json({ version: await kinship.getVersion(ctx, version) });
  }),
);

/** 回滚到指定版本 */
kinshipRouter.post(
  '/versions/:version/rollback',
  requireFamily('kinship:delete'),
  writeLimiter,
  validateBody(rollbackRelationshipSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version <= 0) throw badRequest('版本号不合法');
    const stats = await kinship.rollback(user.id, ctx, version, req.body.reason ?? null, clientMeta(req));
    res.json({ ok: true, stats });
  }),
);

/** 导出 JSON / CSV / GraphML（同步下载） */
kinshipRouter.get(
  '/export',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const format = String(req.query.format ?? 'json') as KinshipExportFormat;
    if (!['json', 'csv', 'graphml'].includes(format)) throw badRequest('只支持 json / csv / graphml 格式');
    const out = await renderKinshipExport(ctx, format);
    await auditKinshipExport(user.id, ctx, format, clientMeta(req));
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }),
);

/** 手工新建关系 */
kinshipRouter.post(
  '/edges',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(createRelationshipSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const edge = await kinship.createEdge(user.id, ctx, req.body, clientMeta(req));
    res.status(201).json({ relationship: edge });
  }),
);

/** 修改关系（校正类型/称谓/备注，或把建议改成采纳/忽略） */
kinshipRouter.patch(
  '/edges/:edgeId',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(updateRelationshipSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const edge = await kinship.updateEdge(user.id, ctx, req.params.edgeId!, req.body, clientMeta(req));
    res.json({ relationship: edge });
  }),
);

/** 删除关系 */
kinshipRouter.delete(
  '/edges/:edgeId',
  requireFamily('kinship:delete'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await kinship.deleteEdge(user.id, ctx, req.params.edgeId!, clientMeta(req));
    res.status(204).end();
  }),
);
