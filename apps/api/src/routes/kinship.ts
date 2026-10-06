import { Router } from 'express';
import {
  anchorSchema,
  applyInferenceSchema,
  ignoreIssueSchema,
  kinEdgeSchema,
  updateKinEdgeSchema,
} from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { badRequest } from '../http/errors';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as kinshipService from '../services/kinshipService';

export const kinshipRouter = Router({ mergeParams: true });

// 图谱（人物 + 边 + 推导称呼）
kinshipRouter.get(
  '/graph',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await kinshipService.getGraph(ctx));
  }),
);

// 矛盾列表（?resolved=1 时连已解决的一起返回）
kinshipRouter.get(
  '/issues',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const includeResolved = req.query.resolved === '1' || req.query.resolved === 'true';
    res.json(await kinshipService.listIssues(ctx, includeResolved));
  }),
);

// 推导预览（不落库）
kinshipRouter.get(
  '/inference',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await kinshipService.previewInference(ctx));
  }),
);

// 采纳推导
kinshipRouter.post(
  '/inference/apply',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(applyInferenceSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json(
      await kinshipService.applyInference(
        user.id,
        ctx,
        { includeRoleSuggestions: req.body.includeRoleSuggestions ?? false },
        clientMeta(req),
      ),
    );
  }),
);

// 设置锚点人物
kinshipRouter.post(
  '/anchor',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(anchorSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json(await kinshipService.setAnchor(user.id, ctx, req.body.personId, clientMeta(req)));
  }),
);

// 手动新增关系
kinshipRouter.post(
  '/edges',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(kinEdgeSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await kinshipService.createEdge(
      user.id,
      ctx,
      {
        fromPersonId: req.body.fromPersonId,
        toPersonId: req.body.toPersonId,
        type: req.body.type,
        note: req.body.note ?? null,
        confirmed: req.body.confirmed,
      },
      clientMeta(req),
    );
    res.status(201).json(result);
  }),
);

kinshipRouter.patch(
  '/edges/:edgeId',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(updateKinEdgeSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json(
      await kinshipService.updateEdge(
        user.id,
        ctx,
        req.params.edgeId!,
        {
          note: req.body.note,
          confirmed: req.body.confirmed,
          confidence: req.body.confidence,
        },
        clientMeta(req),
      ),
    );
  }),
);

kinshipRouter.delete(
  '/edges/:edgeId',
  requireFamily('kinship:write'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await kinshipService.deleteEdge(user.id, ctx, req.params.edgeId!, clientMeta(req));
    res.status(204).end();
  }),
);

// 忽略/恢复矛盾
kinshipRouter.post(
  '/issues/:issueId/ignore',
  requireFamily('kinship:write'),
  writeLimiter,
  validateBody(ignoreIssueSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json(await kinshipService.setIssueIgnored(user.id, ctx, req.params.issueId!, req.body.ignore, clientMeta(req)));
  }),
);

// 版本列表 / 详情 / 回滚
kinshipRouter.get(
  '/versions',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await kinshipService.listVersions(ctx));
  }),
);

kinshipRouter.get(
  '/versions/:versionId',
  requireFamily('kinship:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await kinshipService.getVersion(ctx, req.params.versionId!));
  }),
);

kinshipRouter.post(
  '/versions/:versionId/revert',
  requireFamily('kinship:write'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json(await kinshipService.revertVersion(user.id, ctx, req.params.versionId!, clientMeta(req)));
  }),
);

// 导出：GEDCOM / DOT / CSV
kinshipRouter.get(
  '/export',
  requireFamily('kinship:export'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const format = String(req.query.format ?? 'gedcom');
    if (format !== 'gedcom' && format !== 'dot' && format !== 'csv') {
      throw badRequest('格式只支持 gedcom / dot / csv');
    }
    const file = await kinshipService.exportKinship(ctx, format, user.id, clientMeta(req));
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.send(file.content);
  }),
);
