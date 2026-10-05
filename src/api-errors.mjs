export function apiErrorMessage(value) {
  const code=value.code||value.error;
  return {TOKEN_REQUIRED:'页面已过期，请先复制未保存的内容，再刷新页面后重试。',HOST_DENIED:'访问地址不正确，请从本机插件地址重新打开。',ORIGIN_DENIED:'请求来源不正确，请从本机插件页面操作。'}[code]||value.error||'操作失败';
}
