// Content script para detectar automáticamente datos de Woffu
// Se ejecuta en todas las páginas *.woffu.com

function extractWoffuData() {
  const data = {
    baseUrl: null,
    userId: null,
    bearerToken: null,
    utcOffset: null
  };

  // Calcular el offset UTC correcto para la fecha actual
  // El offset se calcula en minutos (positivo para UTC+, negativo para UTC-)
  const now = new Date();
  const utcOffsetMinutes = -now.getTimezoneOffset(); // getTimezoneOffset() devuelve el offset invertido
  data.utcOffset = utcOffsetMinutes;

  // Extraer base URL del dominio actual
  if (window.location.hostname.endsWith('.woffu.com')) {
    data.baseUrl = `${window.location.protocol}//${window.location.hostname}`;
  }

  // Intentar extraer el token del localStorage
  try {
    const localStorageKeys = Object.keys(localStorage);
    for (const key of localStorageKeys) {
      try {
        const value = localStorage.getItem(key);
        if (!value) continue;

        // Buscar tokens JWT (formato: xxx.yyy.zzz)
        if (typeof value === 'string' && value.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/)) {
          data.bearerToken = value;
        }

        // Intentar parsear JSON para buscar tokens
        if (value.startsWith('{') || value.startsWith('[')) {
          const parsed = JSON.parse(value);
          
          // Buscar token en diferentes posibles ubicaciones
          if (parsed.token) data.bearerToken = parsed.token;
          if (parsed.accessToken) data.bearerToken = parsed.accessToken;
          if (parsed.access_token) data.bearerToken = parsed.access_token;
          if (parsed.bearerToken) data.bearerToken = parsed.bearerToken;
          if (parsed.jwt) data.bearerToken = parsed.jwt;
          
          // Buscar userId
          if (parsed.userId) data.userId = parsed.userId.toString();
          if (parsed.user_id) data.userId = parsed.user_id.toString();
          if (parsed.id) data.userId = parsed.id.toString();
          if (parsed.user?.id) data.userId = parsed.user.id.toString();
          if (parsed.user?.userId) data.userId = parsed.user.userId.toString();
        }
      } catch (e) {
        // Ignorar errores de parsing
      }
    }
  } catch (e) {
    console.warn('Error accediendo a localStorage:', e);
  }

  // Intentar extraer de sessionStorage
  try {
    const sessionStorageKeys = Object.keys(sessionStorage);
    for (const key of sessionStorageKeys) {
      try {
        const value = sessionStorage.getItem(key);
        if (!value) continue;

        // Buscar tokens JWT
        if (typeof value === 'string' && value.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/)) {
          if (!data.bearerToken) data.bearerToken = value;
        }

        // Intentar parsear JSON
        if (value.startsWith('{') || value.startsWith('[')) {
          const parsed = JSON.parse(value);
          
          if (parsed.token && !data.bearerToken) data.bearerToken = parsed.token;
          if (parsed.accessToken && !data.bearerToken) data.bearerToken = parsed.accessToken;
          if (parsed.access_token && !data.bearerToken) data.bearerToken = parsed.access_token;
          if (parsed.userId && !data.userId) data.userId = parsed.userId.toString();
          if (parsed.user?.id && !data.userId) data.userId = parsed.user.id.toString();
        }
      } catch (e) {
        // Ignorar errores
      }
    }
  } catch (e) {
    console.warn('Error accediendo a sessionStorage:', e);
  }

  // Intentar extraer userId de la URL o del DOM
  try {
    // Buscar en la URL (ej: /users/xxxxxx/...)
    const userIdMatch = window.location.pathname.match(/\/users\/(\d+)/);
    if (userIdMatch && !data.userId) {
      data.userId = userIdMatch[1];
    }

    // Buscar en atributos data-* del DOM
    const userElements = document.querySelectorAll('[data-user-id], [data-userid], [data-id]');
    for (const el of userElements) {
      const userId = el.dataset.userId || el.dataset.userid || el.dataset.id;
      if (userId && userId.match(/^\d+$/) && !data.userId) {
        data.userId = userId;
        break;
      }
    }
  } catch (e) {
    console.warn('Error extrayendo userId del DOM:', e);
  }

  // Interceptar requests para capturar el token del header Authorization
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const request = args[0];
    if (request && typeof request === 'object' && request.headers) {
      const authHeader = request.headers.get?.('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ') && !data.bearerToken) {
        data.bearerToken = authHeader.substring(7);
      }
    }
    return originalFetch.apply(this, args);
  };

  return data;
}

// Listener para mensajes desde el popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getWoffuData") {
    const data = extractWoffuData();
    sendResponse({ data });
  }
  return true; // Mantener el canal abierto para respuesta asíncrona
});

// Detectar y guardar datos automáticamente cuando la página esté lista
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const data = extractWoffuData();
      if (data.baseUrl || data.userId || data.bearerToken) {
        console.info('[TofuPalWoffu] Datos detectados:', {
          baseUrl: data.baseUrl ? '✓' : '✗',
          userId: data.userId ? '✓' : '✗',
          bearerToken: data.bearerToken ? '✓ (oculto)' : '✗',
          utcOffset: data.utcOffset !== null ? `✓ (${data.utcOffset} minutos)` : '✗'
        });
      }
    }, 1000);
  });
} else {
  setTimeout(() => {
    const data = extractWoffuData();
    if (data.baseUrl || data.userId || data.bearerToken) {
      console.info('[TofuPalWoffu] Datos detectados:', {
        baseUrl: data.baseUrl ? '✓' : '✗',
        userId: data.userId ? '✓' : '✗',
        bearerToken: data.bearerToken ? '✓ (oculto)' : '✗',
        utcOffset: data.utcOffset !== null ? `✓ (${data.utcOffset} minutos)` : '✗'
      });
    }
  }, 1000);
}

