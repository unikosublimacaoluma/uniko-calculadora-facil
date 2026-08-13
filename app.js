const DEFAULT_RATES = {
  pix: 0,
  debit: 0.99,
  credit: {
    1: 3.49, 2: 6.49, 3: 7.49, 4: 7.99, 5: 8.49, 6: 9.49,
    7: 9.99, 8: 10.49, 9: 10.99, 10: 11.49, 11: 12.49, 12: 13.99
  }
};

const KEYS = {
  settings: "uniko_calculadora_settings_v2",
  history: "uniko_calculadora_history_v2",
  pin: "uniko_calculadora_pin_v2"
};

const $ = (id) => document.getElementById(id);
const clone = (obj) => JSON.parse(JSON.stringify(obj));

let state = {
  rawDigits: "",
  method: "credit",
  installments: 1,
  promoMode: false,
  settings: loadSettings(),
  history: loadHistory(),
  deferredInstallPrompt: null,
  pinMode: "verify"
};

function initialSettings() {
  return {
    normalRates: clone(DEFAULT_RATES),
    promoEnabled: false,
    promoRates: clone(DEFAULT_RATES),
    updatedAt: new Date().toISOString()
  };
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS.settings) || "null");
    if (!parsed || !parsed.normalRates) return initialSettings();
    return {
      normalRates: parsed.normalRates,
      promoEnabled: Boolean(parsed.promoEnabled),
      promoRates: parsed.promoRates || clone(DEFAULT_RATES),
      updatedAt: parsed.updatedAt || new Date().toISOString()
    };
  } catch {
    return initialSettings();
  }
}

function saveSettingsToStorage() {
  state.settings.updatedAt = new Date().toISOString();
  localStorage.setItem(KEYS.settings, JSON.stringify(state.settings));
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS.history) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(KEYS.history, JSON.stringify(state.history.slice(0, 30)));
}

function formatBRLFromCents(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format((Number(cents) || 0) / 100).replace(/\u00a0/g, " ");
}

function formatNumberBR(value) {
  return Number(value || 0).toFixed(2).replace(".", ",");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function getNetCents() {
  return state.rawDigits ? Number(state.rawDigits) : 0;
}

function getRate() {
  const table = state.promoMode && state.settings.promoEnabled
    ? state.settings.promoRates
    : state.settings.normalRates;
  if (state.method === "pix") return Number(table.pix || 0);
  if (state.method === "debit") return Number(table.debit || 0);
  return Number(table.credit[state.installments] || 0);
}

function calculate(netCents, ratePercent, installments, method) {
  const r = Math.max(0, Math.min(99.999, Number(ratePercent || 0))) / 100;
  const n = Math.max(1, Math.floor(installments || 1));
  if (netCents <= 0) {
    return { chargeCents: 0, installmentCents: 0, feeCents: 0, netReceivedCents: 0 };
  }

  const grossCentsExact = netCents / (1 - r);
  let chargeCents;
  let installmentCents;

  if (method === "credit" && n > 1) {
    installmentCents = Math.ceil(grossCentsExact / n - 1e-9);
    chargeCents = installmentCents * n;
  } else {
    chargeCents = Math.ceil(grossCentsExact - 1e-9);
    installmentCents = chargeCents;
  }

  const compute = () => {
    const feeCents = Math.round(chargeCents * r);
    const netReceivedCents = chargeCents - feeCents;
    return { feeCents, netReceivedCents };
  };

  let parts = compute();

  let guard = 0;
  while (parts.netReceivedCents < netCents && guard < 100) {
    if (method === "credit" && n > 1) {
      installmentCents += 1;
      chargeCents = installmentCents * n;
    } else {
      chargeCents += 1;
      installmentCents = chargeCents;
    }
    parts = compute();
    guard += 1;
  }

  return {
    chargeCents,
    installmentCents,
    feeCents: parts.feeCents,
    netReceivedCents: parts.netReceivedCents
  };
}

function currentCalculation() {
  const netCents = getNetCents();
  const rate = getRate();
  const n = state.method === "credit" ? state.installments : 1;
  return {
    netCents,
    rate,
    installments: n,
    method: state.method,
    ...calculate(netCents, rate, n, state.method)
  };
}

function buildCustomerMessage(calc) {
  const pix = formatBRLFromCents(calc.netCents);
  if (calc.method === "pix") return `No Pix fica ${pix}.`;
  if (calc.method === "debit") {
    return `No Pix fica ${pix}. No cartão de débito fica ${formatBRLFromCents(calc.chargeCents)}.`;
  }
  if (calc.installments <= 1) {
    return `No Pix fica ${pix}. No cartão de crédito à vista fica ${formatBRLFromCents(calc.chargeCents)}.`;
  }
  return `No Pix fica ${pix}. No cartão em ${calc.installments}x fica ${formatBRLFromCents(calc.chargeCents)} — ${calc.installments}x de ${formatBRLFromCents(calc.installmentCents)}.`;
}

function renderInstallments() {
  const grid = $("installmentsGrid");
  grid.innerHTML = "";
  for (let i = 1; i <= 12; i++) {
    const btn = document.createElement("button");
    btn.textContent = `${i}x`;
    btn.className = state.installments === i ? "active" : "";
    btn.addEventListener("click", () => {
      state.installments = i;
      render();
    });
    grid.appendChild(btn);
  }
}

function renderPaymentMethods() {
  document.querySelectorAll("#paymentMethods button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.method === state.method);
  });
  $("installmentsArea").classList.toggle("hidden", state.method !== "credit");
}

function renderHistory() {
  const list = $("historyList");
  if (!state.history.length) {
    list.innerHTML = '<p class="empty">Nenhum cálculo salvo.</p>';
    $("clearHistoryBtn").classList.add("hidden");
    return;
  }
  $("clearHistoryBtn").classList.remove("hidden");
  list.innerHTML = state.history.map((item) => {
    const methodLabel = item.method === "pix" ? "Pix" : item.method === "debit" ? "Débito" : `Crédito ${item.installments}x`;
    return `
      <div class="history-item">
        <div class="history-main">
          <span>${formatBRLFromCents(item.netCents)}</span>
          <span>${formatBRLFromCents(item.chargeCents)}</span>
        </div>
        <div class="history-sub">${methodLabel} • ${formatNumberBR(item.rate)}% • ${formatDateTime(item.at)}</div>
      </div>
    `;
  }).join("");
}

function render() {
  renderPaymentMethods();
  renderInstallments();

  const calc = currentCalculation();
  const hasValue = calc.netCents > 0;

  $("chargeValue").textContent = formatBRLFromCents(calc.chargeCents);
  $("rateValue").textContent = `${formatNumberBR(calc.rate)}%`;
  $("feeValue").textContent = formatBRLFromCents(calc.feeCents);
  $("netValue").textContent = formatBRLFromCents(calc.netReceivedCents);

  const showInstallment = calc.method === "credit" && calc.installments > 1 && hasValue;
  $("installmentLine").classList.toggle("hidden", !showInstallment);
  if (showInstallment) {
    $("installmentLine").textContent = `${calc.installments}x de ${formatBRLFromCents(calc.installmentCents)}`;
  }

  $("copyBtn").disabled = !hasValue;
  $("whatsappBtn").disabled = !hasValue;
  $("saveHistoryBtn").disabled = !hasValue;
  $("clearAmountBtn").classList.toggle("hidden", !hasValue);

  const message = hasValue ? buildCustomerMessage(calc) : "";
  $("messagePreview").textContent = message;
  $("messagePreview").classList.toggle("hidden", !hasValue);

  $("promoCard").classList.toggle("hidden", !state.settings.promoEnabled);
  $("promoSwitch").checked = state.promoMode && state.settings.promoEnabled;
  $("modeLabel").textContent = state.promoMode && state.settings.promoEnabled
    ? "taxas promocionais"
    : "taxas normais";
  $("ratesUpdatedAt").textContent = formatDateTime(state.settings.updatedAt);

  renderHistory();
}

function setAmountFromTyped(value) {
  state.rawDigits = String(value || "").replace(/\D/g, "").slice(0, 12);
  $("amountInput").value = state.rawDigits
    ? formatBRLFromCents(Number(state.rawDigits)).replace("R$ ", "")
    : "";
  render();
}

function saveCurrentToHistory() {
  const calc = currentCalculation();
  if (calc.netCents <= 0) return;
  const same = state.history[0]
    && state.history[0].netCents === calc.netCents
    && state.history[0].chargeCents === calc.chargeCents
    && state.history[0].method === calc.method
    && state.history[0].installments === calc.installments;
  if (!same) {
    state.history.unshift({
      at: new Date().toISOString(),
      netCents: calc.netCents,
      chargeCents: calc.chargeCents,
      installmentCents: calc.installmentCents,
      rate: calc.rate,
      method: calc.method,
      installments: calc.installments
    });
    state.history = state.history.slice(0, 30);
    saveHistory();
    renderHistory();
  }
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getStoredPinHash() {
  return localStorage.getItem(KEYS.pin) || "";
}

function openPinDialog(mode = "verify") {
  state.pinMode = mode;
  const hasPin = Boolean(getStoredPinHash());
  const creating = mode === "create" || !hasPin;
  $("pinTitle").textContent = creating ? "Criar PIN local" : mode === "change" ? "Alterar PIN" : "Acesso às configurações";
  $("pinText").textContent = creating
    ? "Crie um PIN de 4 a 8 números para evitar alterações acidentais."
    : mode === "change"
      ? "Digite o novo PIN e confirme."
      : "Digite seu PIN local.";
  $("pinConfirmArea").classList.toggle("hidden", !creating && mode !== "change");
  $("pinSubmitBtn").textContent = creating || mode === "change" ? "Salvar PIN" : "Entrar";
  $("pinInput").value = "";
  $("pinConfirmInput").value = "";
  $("pinError").classList.add("hidden");
  $("pinDialog").showModal();
  setTimeout(() => $("pinInput").focus(), 50);
}

async function handlePinSubmit(event) {
  event.preventDefault();
  const pin = $("pinInput").value.trim();
  const confirm = $("pinConfirmInput").value.trim();
  const hasPin = Boolean(getStoredPinHash());
  const creating = state.pinMode === "create" || !hasPin || state.pinMode === "change";

  if (!/^\d{4,8}$/.test(pin)) {
    showPinError("Use um PIN de 4 a 8 números.");
    return;
  }

  if (creating) {
    if (pin !== confirm) {
      showPinError("Os PINs não coincidem.");
      return;
    }
    localStorage.setItem(KEYS.pin, await sha256(pin));
    $("pinDialog").close();
    if (state.pinMode === "change") {
      alert("PIN alterado.");
    } else {
      openSettings();
    }
    return;
  }

  if (await sha256(pin) !== getStoredPinHash()) {
    showPinError("PIN incorreto.");
    return;
  }

  $("pinDialog").close();
  openSettings();
}

function showPinError(text) {
  $("pinError").textContent = text;
  $("pinError").classList.remove("hidden");
}

function rateEditorHTML(prefix, table) {
  const lines = [
    ["pix", "Pix", table.pix],
    ["debit", "Débito", table.debit],
    ...Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return [`credit-${n}`, `Crédito ${n}x`, table.credit[n]];
    })
  ];
  return lines.map(([key, label, value]) => `
    <label class="rate-line">
      <span>${label}</span>
      <span><input id="${prefix}-${key}" inputmode="decimal" value="${formatNumberBR(value)}" aria-label="Taxa ${label}"> %</span>
    </label>
  `).join("");
}

function openSettings() {
  $("normalRatesEditor").innerHTML = rateEditorHTML("normal", state.settings.normalRates);
  $("promoRatesEditor").innerHTML = rateEditorHTML("promo", state.settings.promoRates);
  $("promoEnabledSetting").checked = state.settings.promoEnabled;
  $("settingsDialog").showModal();
}

function readRate(prefix, key) {
  const raw = $( `${prefix}-${key}` ).value.replace(",", ".").trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= 100) {
    throw new Error(`Taxa inválida em ${key}.`);
  }
  return Math.round(value * 1000) / 1000;
}

function readTable(prefix) {
  const table = {
    pix: readRate(prefix, "pix"),
    debit: readRate(prefix, "debit"),
    credit: {}
  };
  for (let n = 1; n <= 12; n++) {
    table.credit[n] = readRate(prefix, `credit-${n}`);
  }
  return table;
}

function exportConfig() {
  const payload = {
    app: "UNIKO Calculadora Fácil",
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `uniko-calculadora-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importConfig(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload?.settings?.normalRates) throw new Error("Arquivo de backup inválido.");
  state.settings = {
    normalRates: payload.settings.normalRates,
    promoEnabled: Boolean(payload.settings.promoEnabled),
    promoRates: payload.settings.promoRates || clone(DEFAULT_RATES),
    updatedAt: new Date().toISOString()
  };
  saveSettingsToStorage();
  state.promoMode = false;
  render();
  $("settingsDialog").close();
  alert("Configurações importadas.");
}

function updateOnlineStatus() {
  $("offlineBanner").classList.toggle("hidden", navigator.onLine);
}

function setupEvents() {
  $("amountInput").addEventListener("input", (e) => setAmountFromTyped(e.target.value));
  $("clearAmountBtn").addEventListener("click", () => setAmountFromTyped(""));

  document.querySelectorAll("#paymentMethods button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.method = btn.dataset.method;
      render();
    });
  });

  $("copyBtn").addEventListener("click", async () => {
    const calc = currentCalculation();
    const message = buildCustomerMessage(calc);
    try {
      await navigator.clipboard.writeText(message);
      saveCurrentToHistory();
      alert("Mensagem copiada.");
    } catch {
      alert(message);
    }
  });

  $("whatsappBtn").addEventListener("click", () => {
    const calc = currentCalculation();
    const message = buildCustomerMessage(calc);
    saveCurrentToHistory();
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener");
  });

  $("saveHistoryBtn").addEventListener("click", () => {
    saveCurrentToHistory();
    alert("Cálculo salvo no histórico.");
  });

  $("clearHistoryBtn").addEventListener("click", () => {
    if (confirm("Limpar todo o histórico deste aparelho?")) {
      state.history = [];
      saveHistory();
      renderHistory();
    }
  });

  $("promoSwitch").addEventListener("change", (e) => {
    state.promoMode = e.target.checked && state.settings.promoEnabled;
    render();
  });

  $("settingsBtn").addEventListener("click", () => {
    openPinDialog(getStoredPinHash() ? "verify" : "create");
  });

  $("pinForm").addEventListener("submit", handlePinSubmit);
  $("pinSubmitBtn").addEventListener("click", handlePinSubmit);

  $("closeSettingsBtn").addEventListener("click", () => $("settingsDialog").close());

  $("saveSettingsBtn").addEventListener("click", () => {
    try {
      state.settings.normalRates = readTable("normal");
      state.settings.promoRates = readTable("promo");
      state.settings.promoEnabled = $("promoEnabledSetting").checked;
      if (!state.settings.promoEnabled) state.promoMode = false;
      saveSettingsToStorage();
      render();
      $("settingsDialog").close();
      alert("Taxas salvas neste aparelho.");
    } catch (err) {
      alert(err.message || "Não foi possível salvar.");
    }
  });

  $("resetRatesBtn").addEventListener("click", () => {
    if (!confirm("Restaurar as taxas iniciais da calculadora?")) return;
    state.settings.normalRates = clone(DEFAULT_RATES);
    state.settings.promoRates = clone(DEFAULT_RATES);
    state.settings.promoEnabled = false;
    state.promoMode = false;
    saveSettingsToStorage();
    openSettings();
    render();
  });

  $("changePinBtn").addEventListener("click", () => {
    $("settingsDialog").close();
    openPinDialog("change");
  });

  $("exportBtn").addEventListener("click", exportConfig);
  $("importInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importConfig(file);
    } catch (err) {
      alert(err.message || "Não foi possível importar.");
    } finally {
      e.target.value = "";
    }
  });

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    $("installBtn").classList.remove("hidden");
  });

  $("installBtn").addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $("installBtn").classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    $("installBtn").classList.add("hidden");
    state.deferredInstallPrompt = null;
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (err) {
      console.warn("Service worker não registrado:", err);
    }
  }
}

function init() {
  renderInstallments();
  setupEvents();
  updateOnlineStatus();
  setAmountFromTyped("");
  render();
  registerServiceWorker();
}

init();
