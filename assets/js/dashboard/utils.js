function activeTempUnit() {
  return activeCity.tempUnit === 'F' ? 'F' : 'C';
}

function tempUnitLabel() {
  return `\u00B0${activeTempUnit()}`;
}

function tempFromCelsius(tempC, { decimals = 0, settle = false } = {}) {
  if (!Number.isFinite(tempC)) return null;
  if (activeTempUnit() === 'F') {
    const fahrenheit = (tempC * 9) / 5 + 32;
    if (settle) return Math.round(fahrenheit);
    if (decimals == null) return fahrenheit;
    return Number(fahrenheit.toFixed(decimals));
  }
  if (settle) return Math.round(tempC);
  if (decimals == null) return tempC;
  return Number(tempC.toFixed(decimals));
}

function formatTempFromCelsius(tempC, { decimals = 0, settle = false } = {}) {
  const value = tempFromCelsius(tempC, { decimals, settle });
  return value == null ? '--' : `${value}${tempUnitLabel()}`;
}

function fmtMetarAge(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'updated just now';
  const minutes = Math.floor(seconds / 60);
  return `updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

let cachedTimeNode;
function tickCityClock() {
  const timeNode = cachedTimeNode || (cachedTimeNode = document.getElementById('londonTime'));
  if (!timeNode) return;
  const time = new Date().toLocaleTimeString('en-GB', {
    timeZone: activeCity.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  timeNode.textContent = `${time} ${activeCity.name}`;
}

let cachedMetarUpd;
let metarAgeInterval = setInterval(() => {
  if (metarObsTime) {
    if (!cachedMetarUpd) cachedMetarUpd = document.getElementById('metarUpd');
    if (cachedMetarUpd) cachedMetarUpd.textContent = fmtMetarAge(metarObsTime);
  }
}, 30000);
