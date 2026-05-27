export const apiAuthorizationToken = import.meta.env.VITE_API_AUTHORIZATION_TOKEN?.trim() ?? "";

const apiBaseUrl = import.meta.env.DEV ? "/api" : "https://api.diffonsoclimatizacao.com";

export const endpoints = {
  authUrl: import.meta.env.VITE_AUTH_URL?.trim() || `${apiBaseUrl}/login.php`,
  forgotPasswordUrl:
    import.meta.env.VITE_FORGOT_PASSWORD_URL?.trim() ||
    `${apiBaseUrl}/esqueceusenha.php`,
  serviceOrdersUrl:
    import.meta.env.VITE_SERVICE_ORDERS_URL?.trim() ||
    `${apiBaseUrl}/ordemservicos.php`,
  serviceOrderDetailsUrl:
    import.meta.env.VITE_SERVICE_ORDER_DETAILS_URL?.trim() ||
    `${apiBaseUrl}/buscardadosordemservico.php`,
  changeOrderStatusUrl:
    import.meta.env.VITE_CHANGE_ORDER_STATUS_URL?.trim() ||
    `${apiBaseUrl}/mudarsituacaoordem.php`,
  finishOrderUrl:
    import.meta.env.VITE_FINISH_ORDER_URL?.trim() ||
    `${apiBaseUrl}/finalizarordemservico.php`,
  syncUrl: import.meta.env.VITE_SYNC_URL?.trim() ?? "",
};
