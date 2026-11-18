/**
 * Backend error code → operator-facing Chinese copy (DESIGN §6.4).
 *
 * The raw `code` and `request_id` are surfaced next to the message so an
 * operator can correlate a failure with core logs without guessing.
 */

import { ApiError } from './api.js';

export interface ErrorPresentation {
  title: string;
  detail: string | null;
  code: string;
  requestId: string | null;
  retryAfterSeconds: number | null;
}

const MESSAGES: Record<string, { title: string; detail?: string }> = {
  NOT_UNLOCKED: {
    title: '网关已锁定',
    detail: '核心当前未解锁，请重新输入管理密码后再审批。',
  },
  INVALID_STATE: {
    title: '提案状态已变化',
    detail: '该提案可能已被其他人批准或拒绝、审批窗口已过期，或当前状态不允许此操作。列表已刷新。',
  },
  CSRF_REJECTED: {
    title: 'CSRF 校验失败',
    detail: '安全令牌缺失或无效。页面刷新后内存中的令牌会丢失，请重新解锁。',
  },
  RATE_LIMITED: {
    title: '尝试过于频繁',
    detail: '连续失败会触发指数退避。',
  },
  UNAUTHENTICATED: {
    title: '会话已失效',
    detail: '会话可能已空闲超时（10 分钟）或核心已重启，请重新解锁。',
  },
  LOCKED: {
    title: '网关正在锁定',
    detail: '核心正在中止进行中的查询，请稍后重新解锁。',
  },
  ALREADY_CONFIGURED: {
    title: '网关已完成初始化',
    detail: '请直接使用管理密码解锁。',
  },
  RESULT_EXPIRED: {
    title: '查询结果已过期',
    detail: '结果从执行完成时刻起只保留 24 小时，核心已将其清理。',
  },
  PROPOSAL_NOT_FOUND: {
    title: '提案不存在',
    detail: '提案 ID 无效，或已被清理。',
  },
  POLICY_DENIED: {
    title: '策略复检未通过',
    detail: '提案在提交后策略版本或 SQL 校验发生变化，未被执行并已标记失败。',
  },
  SOURCE_NOT_FOUND: {
    title: '数据源不存在',
    detail: '该提案引用的数据源已被删除。',
  },
  QUERY_TIMEOUT: {
    title: '查询超时',
    detail: '数据库在提案设定的超时时间内没有完成查询。',
  },
  QUERY_FAILED: {
    title: '查询执行失败',
    detail: '核心只返回错误码与数据库错误号，不暴露驱动文本。',
  },
  INVALID_REQUEST: {
    title: '请求参数无效',
    detail: '请检查输入内容后重试。',
  },
  INVALID_JSON: {
    title: '请求格式无效',
    detail: '客户端发送的 JSON 无法解析。',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    title: '请求格式无效',
    detail: '核心只接受 application/json 请求。',
  },
  INTERNAL_ERROR: {
    title: '核心内部错误',
    detail: '请查看核心日志并携带 request id 排查。',
  },
  NETWORK_ERROR: {
    title: '无法连接核心服务',
    detail: '请确认 core 正在 127.0.0.1:43119 运行，且开发服务器的 /v1 代理可用。',
  },
  ORIGIN_REJECTED: {
    title: '请求来源被拒绝',
    detail: '核心只允许同源请求；开发代理必须把 Host 与 Origin 改写为核心地址。',
  },
  TIMEOUT: {
    title: '请求超时',
    detail: '核心可能仍在执行；请刷新列表确认提案的最终状态。',
  },
  CSRF_MISSING: {
    title: '缺少 CSRF 令牌',
    detail: '安全令牌只保存在内存中，请重新解锁后再试。',
  },
  HTTP_404: {
    title: '接口不存在',
    detail: '请确认 Web 与 core 的版本匹配。',
  },
  HTTP_405: {
    title: '请求方法不被允许',
    detail: '请确认 Web 与 core 的版本匹配。',
  },
};

export function describeError(error: unknown): ErrorPresentation {
  if (error instanceof ApiError) {
    const known = MESSAGES[error.code];
    let detail = known?.detail ?? (error.message || null);
    if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== null) {
      detail = `请在 ${error.retryAfterSeconds} 秒后重试。连续失败会触发指数退避。`;
    }
    return {
      title: known?.title ?? `请求失败（${error.code}）`,
      detail,
      code: error.code,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  if (error instanceof Error && error.message.length > 0) {
    return {
      title: '操作失败',
      detail: error.message,
      code: 'UNKNOWN',
      requestId: null,
      retryAfterSeconds: null,
    };
  }

  return {
    title: '操作失败',
    detail: '发生未知错误。',
    code: 'UNKNOWN',
    requestId: null,
    retryAfterSeconds: null,
  };
}

/** Errors that mean the in-memory cookie session can no longer be used. */
export function isSessionLost(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'UNAUTHENTICATED' ||
      error.code === 'NOT_UNLOCKED' ||
      error.code === 'CSRF_REJECTED' ||
      error.code === 'CSRF_MISSING' ||
      error.code === 'LOCKED')
  );
}

/** Errors that mean the gateway is locked or the session expired. */
export function isGatewayLocked(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'NOT_UNLOCKED' || error.code === 'LOCKED')
  );
}
