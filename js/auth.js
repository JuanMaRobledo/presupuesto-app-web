// Login con la cuenta de Google del que abre la página (OAuth del lado del
// navegador, vía Google Identity Services) — sin backend y sin ninguna
// llave guardada. El token vive solo en memoria de esta pestaña; hay que
// volver a iniciar sesión cada vez que expira (normalmente ~1 hora) o se
// recarga la página.
const Auth = (() => {
  let tokenClient = null;
  let accessToken = null;

  // El script de Google (accounts.google.com/gsi/client) se carga con
  // "async" en index.html, así que puede terminar de cargar antes o
  // después de que corra este init() — no hay garantía de orden. Si
  // llamáramos a google.accounts directo acá podría no existir todavía
  // ("google is not defined"). Se reintenta cada 50ms hasta que esté listo.
  function init(onSignedIn) {
    if (typeof google === "undefined" || !google.accounts) {
      setTimeout(() => init(onSignedIn), 50);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: (resp) => {
        if (resp.error) {
          console.error("Error de autenticación:", resp);
          alert("No se pudo iniciar sesión con Google: " + resp.error);
          return;
        }
        accessToken = resp.access_token;
        onSignedIn();
      },
    });
  }

  function signIn() {
    if (!tokenClient) {
      alert("Google todavía está cargando — esperá un segundo y probá de nuevo.");
      return;
    }
    tokenClient.requestAccessToken({ prompt: "" });
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
  }

  function getToken() {
    return accessToken;
  }

  function isSignedIn() {
    return !!accessToken;
  }

  return { init, signIn, signOut, getToken, isSignedIn };
})();
