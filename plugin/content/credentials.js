/* ResearchGrid credential storage. AGPL-3.0-or-later. */
// Bootstrap loads this script into an explicit object scope; export a top-level var.
var RGCredentials = (function () {
  "use strict";
  const ORIGIN = "https://researchgrid.invalid";
  const REALM = "ResearchGrid API · ";
  const USERNAME = "ResearchGrid API Key";
  function create({ Services, Components }) {
    const manager = Services.logins;
    function realm(endpoint) {
      if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint) || endpoint.length > 2048 || /[\r\n?#]/.test(endpoint)) {
        throw new Error("请先配置有效的 API 地址。");
      }
      return REALM + endpoint;
    }
    async function records(endpoint) {
      const httpRealm = realm(endpoint);
      const all = manager.searchLoginsAsync
        ? await manager.searchLoginsAsync({ origin: ORIGIN, httpRealm })
        : manager.findLogins(ORIGIN, null, httpRealm);
      return all.filter(login => (login.origin || login.hostname) === ORIGIN
        && login.httpRealm === httpRealm && login.username === USERNAME);
    }
    return {
      async getKey(endpoint) { return (await records(endpoint))[0]?.password || ""; },
      async setKey(endpoint, value) {
        const key = String(value || "").trim();
        if (!key) throw new Error("请输入 API Key，或使用清除按钮移除已保存的密钥。");
        const info = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
          .createInstance(Components.interfaces.nsILoginInfo);
        info.init(ORIGIN, null, realm(endpoint), USERNAME, key, "", "");
        const existing = await records(endpoint);
        if (existing.length) {
          if (manager.modifyLoginAsync) await manager.modifyLoginAsync(existing[0], info);
          else manager.modifyLogin(existing[0], info);
        } else if (manager.addLoginAsync) await manager.addLoginAsync(info);
        else manager.addLogin(info);
      },
      async clearKey(endpoint) {
        for (const login of await records(endpoint)) {
          if (manager.removeLoginAsync) await manager.removeLoginAsync(login);
          else manager.removeLogin(login);
        }
      },
    };
  }
  return { create };
})();
if (typeof module !== "undefined" && module.exports) module.exports = RGCredentials;
