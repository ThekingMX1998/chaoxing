(() => {
  let previousAuthenticated = null;
  let checking = false;

  const checkSession = async () => {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch("/api/session", {cache: "no-store"});
      const current = await response.json();
      if (previousAuthenticated === null && !current.authenticated && window.location.pathname !== "/") {
        if (current.message) {
          const details = [
            current.message,
            current.loginTime ? `新设备登录时间：${current.loginTime}` : "",
          ].filter(Boolean).join("\n");
          window.sessionStorage.setItem("session-replaced-message", details);
        }
        window.location.replace("/");
        return;
      }
      if (previousAuthenticated === true && !current.authenticated) {
        if (current.message) {
          const details = [
            current.message,
            current.loginTime ? `新设备登录时间：${current.loginTime}` : "",
          ].filter(Boolean).join("\n");
          window.sessionStorage.setItem("session-replaced-message", details);
        }
        if (window.location.pathname === "/") {
          window.location.reload();
        } else {
          window.location.href = "/";
        }
        return;
      }
      previousAuthenticated = Boolean(current.authenticated);
    } catch {
      // 会话检查失败时保留当前页面，等待下一次检查。
    } finally {
      checking = false;
    }
  };

  checkSession();
  window.setInterval(checkSession, 5000);
})();
