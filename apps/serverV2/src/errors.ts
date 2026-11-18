export const ERRORS = {
  INVALID_REQUEST: { message: '请求参数无效', status: 400 },
  INVALID_JSON: { message: '请求 JSON 格式无效', status: 400 },
  UNSUPPORTED_MEDIA_TYPE: { message: '请求内容类型必须为 application/json', status: 415 },
  PAYLOAD_TOO_LARGE: { message: '请求内容过大', status: 413 },
  NOT_FOUND: { message: '接口不存在', status: 404 },
  METHOD_NOT_ALLOWED: { message: '请求方法不支持', status: 405 },
  SERVICE_UNAVAILABLE: { message: '业务服务尚未就绪', status: 503 },
  SERVER_SHUTTING_DOWN: { message: '服务正在关闭', status: 503 },
  INTERNAL_ERROR: { message: '服务内部错误', status: 500 },
  STORAGE_BUSY: { message: '存储暂时繁忙，请稍后重试', status: 503 },
  RESOURCE_CONFLICT: { message: '资源已存在或名称重复', status: 409 },
  REFERENCE_CONFLICT: { message: '资源仍被引用或关联数据已变化', status: 409 },
  PRESET_NOT_FOUND: { message: '预设不存在', status: 404 },
  MODEL_CONFIG_NOT_FOUND: { message: '模型配置不存在', status: 404 },
  APP_SETTINGS_MISSING: { message: '应用设置缺失', status: 500 },
  WORLD_NOT_FOUND: { message: '世界不存在', status: 404 },
  SESSION_NOT_FOUND: { message: '会话不存在', status: 404 },
  ENTRY_NOT_FOUND: { message: '消息不存在', status: 404 },
  TIP_CONFLICT: { message: '会话末尾已变化，只能在当前末尾追加', status: 409 },
  INVALID_PARENT_CHAIN: { message: '消息历史关系无效', status: 409 },
  INVALID_ENTRY_TYPE: { message: '消息类型无效', status: 400 },
  USER_ENTRY_METRICS_NOT_ALLOWED: { message: '用户消息不能保存模型调用计量', status: 400 },
  DUPLICATE_REQUEST_METRICS: { message: '同一模型请求的计量不能重复保存', status: 409 },
  INVALID_STATE_OWNER: { message: '状态所属对象标识无效', status: 400 },
  INVALID_JSON_VALUE: { message: '数据包含无效的 JSON 值', status: 400 },
  CYCLIC_JSON_VALUE: { message: 'JSON 数据不能包含循环引用', status: 400 },
  INVALID_JSON_OBJECT: { message: 'JSON 对象无效', status: 400 },
  INVALID_JSON_KEY: { message: 'JSON 字段名无效', status: 400 },
  INVALID_JSON_ARRAY: { message: 'JSON 数组无效', status: 400 },
  INVALID_JSON_PROPERTY: { message: 'JSON 属性无效', status: 400 },
  JSON_ARRAY_REQUIRED: { message: '此字段必须是 JSON 数组', status: 400 },
  JSON_OBJECT_REQUIRED: { message: '此字段必须是 JSON 对象', status: 400 },
  INVALID_WORLD_FIELD: { message: '世界字段无效', status: 400 },
  INVALID_WORLD_TAGS: { message: '世界标签无效', status: 400 },
  INVALID_WORLD_PAGINATION: { message: '世界列表分页参数无效', status: 400 },
  INVALID_WORLD_ID: { message: '世界标识无效', status: 400 },
  INVALID_WORLD_NAME: { message: '世界名称无效', status: 400 },
  INVALID_WORLD_PACKAGE_PATH: { message: '世界资源路径无效', status: 400 },
  INVALID_WORLD_DIRECTORY: { message: '世界存储目录无效', status: 500 },
  INVALID_WORLD_ORIGINAL: { message: '世界原始文件无效', status: 500 },
  AMBIGUOUS_WORLD_ORIGINAL: { message: '世界原始文件存在冲突', status: 409 },
  INVALID_WORLD_ORIGINAL_FORMAT: { message: '世界原始文件格式无效', status: 400 },
  INVALID_WORLD_ORIGINAL_SIZE: { message: '世界原始文件大小无效', status: 400 },
  WORLD_SOURCE_FORMAT_CONFLICT: { message: '已保存的世界原始文件格式不同', status: 409 },
  WORLD_ORIGINAL_NOT_FOUND: { message: '世界原始文件不存在', status: 404 },
  WORLD_PACKAGE_FILE_NOT_FOUND: { message: '世界资源文件不存在', status: 404 },
  AMBIGUOUS_WORLD_PACKAGE_PATH: { message: '世界资源路径存在冲突', status: 409 },
  INVALID_WORLD_PACKAGE_FILE: { message: '世界资源文件无效', status: 400 },
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** Stable business code; HTTP translates it without exposing internal exception text. */
export class AppError extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string) {
    super(detail ? code + ': ' + detail : code);
    this.name = 'AppError';
  }
}
