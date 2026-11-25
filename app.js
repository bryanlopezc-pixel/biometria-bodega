(() => {
  'use strict';

  /* ==========================================================================
   * 1. CONFIGURACIÓN
   * ========================================================================== */
  const CONFIG = Object.freeze({
    // Reemplaza por tu URL de implementación de Google Apps Script (.../exec)
    URL_SCRIPT: 'https://script.google.com/macros/s/AKfycby6kSM1-6EGW8MKDB08iH8BGUlzegCkhOceqK5ckzuiImKqdJHPhaQchAuuqsBEcCVf/exec',
    STORAGE_TOKEN: 'biometria_aplicada_clave_bodega',
    STORAGE_CACHE: 'biometria_aplicada_cache_v1',
    STORAGE_LOCK_UNTIL: 'biometria_aplicada_lock_until',
    REFRESH_INTERVAL_MS: 15000,
    REQUEST_TIMEOUT_MS: 10000,
    MAX_RETRIES: 2,
    MAX_FAILED_ATTEMPTS: 5,
    LOCK_DURATION_MS: 30000,
    DEFAULT_LIMIT: 200
  });

  /* ==========================================================================
   * 2. AUTENTICACIÓN Y BLOQUEO POR INTENTOS
   * ========================================================================== */
  const AuthService = (() => {
    let failedAttempts = 0;

    function obtenerClave() {
      return localStorage.getItem(CONFIG.STORAGE_TOKEN) || '';
    }

    function guardarClave(clave) {
      localStorage.setItem(CONFIG.STORAGE_TOKEN, clave);
    }

    function limpiarClave() {
      localStorage.removeItem(CONFIG.STORAGE_TOKEN);
    }

    function segundosBloqueoRestantes() {
      const lockUntil = parseInt(localStorage.getItem(CONFIG.STORAGE_LOCK_UNTIL) || '0', 10);
      const diff = lockUntil - Date.now();
      return diff > 0 ? Math.ceil(diff / 1000) : 0;
    }

    function registrarFallo() {
      failedAttempts++;
      if (failedAttempts >= CONFIG.MAX_FAILED_ATTEMPTS) {
        localStorage.setItem(CONFIG.STORAGE_LOCK_UNTIL, String(Date.now() + CONFIG.LOCK_DURATION_MS));
        failedAttempts = 0;
      }
    }

    function resetearFallos() {
      failedAttempts = 0;
      localStorage.removeItem(CONFIG.STORAGE_LOCK_UNTIL);
    }

    return {
      obtenerClave,
      guardarClave,
      limpiarClave,
      segundosBloqueoRestantes,
      registrarFallo,
      resetearFallos
    };
  })();

  /* ==========================================================================
   * 3. API Y CACHÉ DE RESPALDO
   * ========================================================================== */
  const ApiService = (() => {
    function leerRespaldoLocal() {
      try {
        const raw = localStorage.getItem(CONFIG.STORAGE_CACHE);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.registros)) {
          return {
            registros: parsed.registros,
            actualizadoEn: parsed.actualizadoEn || 'guardado'
          };
        }
        return null;
      } catch (_) {
        return null;
      }
    }

    function guardarRespaldoLocal(registros, actualizadoEn) {
      try {
        localStorage.setItem(CONFIG.STORAGE_CACHE, JSON.stringify({
          registros,
          actualizadoEn
        }));
      } catch (_) {
        // Ignorar si storage no está disponible
      }
    }

    async function fetchConTimeout(url, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    }

    async function consultarHistorial(clave) {
      if (!CONFIG.URL_SCRIPT || CONFIG.URL_SCRIPT.includes('TU_ID_DE_IMPLEMENTACION')) {
        throw new Error('Configura URL_SCRIPT en app.js.');
      }

      const endpoint = `${CONFIG.URL_SCRIPT}?token=${encodeURIComponent(clave)}&limit=${CONFIG.DEFAULT_LIMIT}&_ts=${Date.now()}`;
      let ultimoError = null;

      for (let intento = 0; intento <= CONFIG.MAX_RETRIES; intento++) {
        try {
          const resp = await fetchConTimeout(endpoint, CONFIG.REQUEST_TIMEOUT_MS);
          if (!resp.ok) {
            throw new Error(`Error HTTP ${resp.status}`);
          }

          const textoPlano = await resp.text();
          let data;
          try {
            data = JSON.parse(textoPlano);
          } catch (_) {
            throw new Error('Respuesta no válida del servidor (verifica permisos de despliegue en Apps Script).');
          }

          if (!data || !data.ok) {
            const msg = (data && data.error) ? data.error : 'Contraseña incorrecta o error del servicio';
            const err = new Error(msg);
            err.esCredencial = String(msg).toLowerCase().includes('token') || String(msg).toLowerCase().includes('contraseña');
            throw err;
          }

          const registros = Array.isArray(data.registros) ? data.registros : [];
          const actualizadoEn = data.actualizadoEn || new Date().toLocaleTimeString('es-CL');
          guardarRespaldoLocal(registros, actualizadoEn);

          return { registros, actualizadoEn };
        } catch (err) {
          ultimoError = err;
          if (err && err.esCredencial) {
            throw err;
          }
          if (intento < CONFIG.MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 700 * (intento + 1)));
          }
        }
      }

      const msgFinal = (ultimoError && ultimoError.name === 'AbortError')
        ? 'Tiempo de espera agotado al consultar el servidor.'
        : ((ultimoError && ultimoError.message) || 'Error de conexión');

      throw new Error(msgFinal);
    }

    return {
      leerRespaldoLocal,
      consultarHistorial
    };
  })();

  /* ==========================================================================
   * 4. LÓGICA DE DOMINIO (MÉTRICAS, FILTROS Y CSV)
   * ========================================================================== */
  const DomainService = (() => {
    function calcularMetricas(lista) {
      let permitidos = 0;
      let denegadoHorario = 0;
      let denegadoUsuario = 0;
      let remotos = 0;

      for (const r of (lista || [])) {
        if (r.estado === 'PERMITIDO') permitidos++;
        if (r.estado === 'DENEGADO_HORARIO') denegadoHorario++;
        if (r.estado === 'DENEGADO_USUARIO') denegadoUsuario++;
        if (r.origen === 'RAINMAKER' && r.estado === 'PERMITIDO') remotos++;
      }

      return { permitidos, denegadoHorario, denegadoUsuario, remotos };
    }

    function filtrarRegistros(lista, { texto = '', origen = '', estado = '' } = {}) {
      const q = String(texto || '').trim().toLowerCase();

      return (lista || []).filter(r => {
        if (origen && r.origen !== origen) return false;
        if (estado && r.estado !== estado) return false;
        if (q) {
          const coincideUsuario = String(r.usuario || '').toLowerCase().includes(q);
          const coincideId = String(r.userId || '').toLowerCase().includes(q);
          if (!coincideUsuario && !coincideId) return false;
        }
        return true;
      });
    }

    function construirCsv(registros) {
      const escaparCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const filas = [
        ['Fecha / Hora', 'ID', 'Usuario', 'Origen', 'Estado'].map(escaparCsv).join(';')
      ];

      for (const r of (registros || [])) {
        filas.push([r.fechaHora, r.userId, r.usuario, r.origen, r.estado].map(escaparCsv).join(';'));
      }

      return '\uFEFF' + filas.join('\n');
    }

    return {
      calcularMetricas,
      filtrarRegistros,
      construirCsv
    };
  })();

  /* ==========================================================================
   * 5. INTERFAZ DE USUARIO (UI)
   * ========================================================================== */
  const UIController = (() => {
    let registrosCache = [];
    let registrosFiltrados = [];
    let isFetching = false;

    const el = {
      estadoSync: document.getElementById('estadoSync'),
      btnToggleClave: document.getElementById('btnToggleClave'),
      btnActualizar: document.getElementById('btnActualizar'),
      authBox: document.getElementById('authBox'),
      tokenApi: document.getElementById('tokenApi'),
      btnIngresar: document.getElementById('btnIngresar'),
      btnOlvidar: document.getElementById('btnOlvidar'),
      mensajeAlerta: document.getElementById('mensajeAlerta'),
      cntPermitidos: document.getElementById('cntPermitidos'),
      cntDenegadoHorario: document.getElementById('cntDenegadoHorario'),
      cntDenegadoUsuario: document.getElementById('cntDenegadoUsuario'),
      cntRemotos: document.getElementById('cntRemotos'),
      filtroTexto: document.getElementById('filtroTexto'),
      filtroOrigen: document.getElementById('filtroOrigen'),
      filtroEstado: document.getElementById('filtroEstado'),
      btnExportarCsv: document.getElementById('btnExportarCsv'),
      cuerpoTabla: document.getElementById('cuerpoTabla')
    };

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[m]));
    }

    function mostrarAlerta(tipo, texto) {
      el.mensajeAlerta.className = 'alert-banner';
      if (!texto) {
        el.mensajeAlerta.textContent = '';
        return;
      }
      el.mensajeAlerta.classList.add(tipo);
      el.mensajeAlerta.textContent = texto;
    }

    function badgeEstado(estado) {
      if (estado === 'PERMITIDO') {
        return `<span class="badge badge-ok">${escapeHtml(estado)}</span>`;
      }
      if (estado === 'DENEGADO_HORARIO') {
        return `<span class="badge badge-warn">${escapeHtml(estado)}</span>`;
      }
      return `<span class="badge badge-bad">${escapeHtml(estado)}</span>`;
    }

    function renderizarMetricas(lista) {
      const m = DomainService.calcularMetricas(lista);
      el.cntPermitidos.textContent = m.permitidos;
      el.cntDenegadoHorario.textContent = m.denegadoHorario;
      el.cntDenegadoUsuario.textContent = m.denegadoUsuario;
      el.cntRemotos.textContent = m.remotos;
    }

    function renderizarTabla() {
      registrosFiltrados = DomainService.filtrarRegistros(registrosCache, {
        texto: el.filtroTexto.value,
        origen: el.filtroOrigen.value,
        estado: el.filtroEstado.value
      });

      if (registrosFiltrados.length === 0) {
        el.cuerpoTabla.innerHTML = '<tr><td colspan="5">No hay registros que coincidan con el filtro.</td></tr>';
        return;
      }

      el.cuerpoTabla.innerHTML = registrosFiltrados.map(r => `
        <tr>
          <td>${escapeHtml(r.fechaHora)}</td>
          <td>${escapeHtml(r.userId)}</td>
          <td>${escapeHtml(r.usuario)}</td>
          <td>${escapeHtml(r.origen)}</td>
          <td>${badgeEstado(r.estado)}</td>
        </tr>
      `).join('');
    }

    function aplicarDatos(lista, etiquetaEstado, esRespaldo) {
      registrosCache = lista;
      el.estadoSync.classList.toggle('cache-mode', Boolean(esRespaldo));
      el.estadoSync.textContent = etiquetaEstado;
      renderizarMetricas(registrosCache);
      renderizarTabla();
    }

    function guardarClave() {
      const seg = AuthService.segundosBloqueoRestantes();
      if (seg > 0) {
        mostrarAlerta('error', `Demasiados intentos fallidos. Espera ${seg} s antes de reintentar.`);
        return;
      }

      const clave = el.tokenApi.value.trim();
      if (!clave) {
        mostrarAlerta('error', 'Escribe la contraseña antes de continuar.');
        return;
      }

      AuthService.guardarClave(clave);
      el.authBox.classList.remove('visible');
      cargarHistorial(true);
    }

    function borrarClave() {
      AuthService.limpiarClave();
      el.tokenApi.value = '';
      el.authBox.classList.add('visible');
      mostrarAlerta('warn', 'Contraseña eliminada de este dispositivo.');
    }

    async function cargarHistorial(esManual) {
      if (isFetching) return;

      const seg = AuthService.segundosBloqueoRestantes();
      if (seg > 0) {
        mostrarAlerta('error', `Demasiados intentos fallidos. Espera ${seg} s antes de reintentar.`);
        return;
      }

      const clave = el.tokenApi.value.trim() || AuthService.obtenerClave();
      if (!clave) {
        el.authBox.classList.add('visible');
        mostrarAlerta('warn', 'Ingresa la contraseña para cargar el historial.');
        return;
      }

      isFetching = true;
      el.btnActualizar.disabled = true;
      el.estadoSync.classList.remove('cache-mode');
      el.estadoSync.textContent = 'Consultando...';
      if (esManual) mostrarAlerta('', '');

      try {
        const { registros, actualizadoEn } = await ApiService.consultarHistorial(clave);
        AuthService.resetearFallos();
        mostrarAlerta('', '');
        aplicarDatos(registros, `En línea · ${actualizadoEn}`, false);
      } catch (err) {
        if (err && err.esCredencial) {
          AuthService.registrarFallo();
          AuthService.limpiarClave();
          el.authBox.classList.add('visible');
        }

        if (registrosCache.length > 0) {
          aplicarDatos(registrosCache, 'Sin red · Mostrando respaldo', true);
          mostrarAlerta('warn', `No se pudo actualizar en vivo (${err.message}). Se muestran los últimos datos guardados.`);
        } else {
          el.estadoSync.classList.remove('cache-mode');
          el.estadoSync.textContent = 'Error de conexión';
          mostrarAlerta('error', `No se pudo cargar el historial: ${err.message}`);
        }
      } finally {
        isFetching = false;
        el.btnActualizar.disabled = false;
      }
    }

    function exportarCsv() {
      if (!registrosFiltrados || registrosFiltrados.length === 0) {
        mostrarAlerta('warn', 'No hay registros visibles para exportar.');
        return;
      }

      const csv = DomainService.construirCsv(registrosFiltrados);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `accesos_bodega_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function bindEvents() {
      el.btnToggleClave.addEventListener('click', () => el.authBox.classList.toggle('visible'));
      el.btnActualizar.addEventListener('click', () => cargarHistorial(true));
      el.btnIngresar.addEventListener('click', guardarClave);
      el.btnOlvidar.addEventListener('click', borrarClave);
      el.tokenApi.addEventListener('keydown', e => {
        if (e.key === 'Enter') guardarClave();
      });
      el.filtroTexto.addEventListener('input', renderizarTabla);
      el.filtroOrigen.addEventListener('change', renderizarTabla);
      el.filtroEstado.addEventListener('change', renderizarTabla);
      el.btnExportarCsv.addEventListener('click', exportarCsv);
    }

    function init() {
      bindEvents();

      const respaldo = ApiService.leerRespaldoLocal();
      if (respaldo && respaldo.registros.length > 0) {
        aplicarDatos(respaldo.registros, `Respaldo: ${respaldo.actualizadoEn}`, true);
      }

      const claveGuardada = AuthService.obtenerClave();
      if (claveGuardada) {
        el.tokenApi.value = claveGuardada;
        cargarHistorial(false);
        setInterval(() => {
          if (!document.hidden && AuthService.obtenerClave()) {
            cargarHistorial(false);
          }
        }, CONFIG.REFRESH_INTERVAL_MS);
      } else {
        el.authBox.classList.add('visible');
      }
    }

    return { init };
  })();

  UIController.init();
})();