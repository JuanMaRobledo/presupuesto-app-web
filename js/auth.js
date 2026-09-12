// Login con la cuenta de Google del que abre la página (OAuth del lado del
// navegador, vía Google Identity Services) — sin backend y sin ninguna
// llave guardada. El token vive solo en memoria de esta pestaña; hay que
// volver a iniciar sesión cada vez que expira (normalmente ~1 hora) o se
// recarga la página.
const Auth = (() => {
  let tokenClient = null;
  let accessToken = null;

  function init(onSignedIn) {
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
