function cityDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: activeCity.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parseUsMetarTenths(rawOb) {
  if (!rawOb) return null;
  const match = rawOb.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (!match) return null;
  const parseSignedTenths = (sign, digits) => (sign === '1' ? -1 : 1) * (parseInt(digits, 10) / 10);
  return {
    tempC: parseSignedTenths(match[1], match[2]),
    dewpC: parseSignedTenths(match[3], match[4]),
  };
}

function getForecastRows() {
  if (hourlyOmState?.rows?.length) {
    return hourlyOmState.rows.map((row) => ({
      hourFrac: row.hourFrac,
      temp: row.temp,
      rain: row.rain || 0,
      rainProb: row.rainProb,
      windSpeed: row.windSpeed,
      windDir: row.windDir,
      label: row.label,
      sourceLabel: hourlyOmState.sourceLabel || activeCity.omSourceLabel || 'Open-Meteo',
    }));
  }

  const h = omData?.minutely_15;
  if (!h?.time?.length) return [];

  const temps = h.temperature_2m || [];
  const rain = h.precipitation || [];
  const windSpeed = h.wind_speed_10m || [];
  const windDir = h.wind_direction_10m || [];

  return h.time.map((time, index) => {
    const temp = temps[index];
    if (typeof temp !== 'number') return null;
    const hour = parseInt(time.substring(11, 13), 10);
    const minute = parseInt(time.substring(14, 16), 10);
    return {
      hourFrac: hour + minute / 60,
      temp,
      rain: typeof rain[index] === 'number' ? rain[index] : 0,
      windSpeed: typeof windSpeed[index] === 'number' ? windSpeed[index] : null,
      windDir: typeof windDir[index] === 'number' ? windDir[index] : null,
      label: time.substring(11, 16),
      sourceLabel: activeCity.omSourceLabel || 'Open-Meteo',
    };
  }).filter(Boolean);
}

function observedTempOptions() {
  return activeCity.usesUsMetarTenths ? { decimals: 1 } : { settle: activeTempUnit() === 'F' };
}

function celsiusFromDisplayTemp(value, unit) {
  return unit === 'F' ? ((value - 32) * 5) / 9 : value;
}

function parseTemperatureHighlightInput(value) {
  const text = `${value || ''}`.trim().replace(',', '.');
  if (!text) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(?:\u00B0?\s*)?([cf\u0441])?$/i);
  if (!match) return { error: 'Enter a number, for example 12C' };

  const target = Number(match[1]);
  if (!Number.isFinite(target)) return { error: 'Enter a valid temperature' };
  const unit = (match[2] || activeTempUnit()).toUpperCase().replace('\u0421', 'C');
  const lowerC = celsiusFromDisplayTemp(target - 0.5, unit);
  const upperC = celsiusFromDisplayTemp(target + 0.5, unit);

  return {
    target,
    unit,
    lowerC: Math.min(lowerC, upperC),
    upperC: Math.max(lowerC, upperC),
  };
}

function formatHourFrac(hourFrac) {
  const bounded = Math.max(0, Math.min(24, hourFrac));
  const totalMinutes = Math.round(bounded * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function temperatureHighlightPeriods(rows, lowerC, upperC) {
  if (!rows.length) return [];
  if (rows.length === 1) {
    const row = rows[0];
    return row.temp >= lowerC && row.temp <= upperC
      ? [{ start: row.hourFrac, end: row.hourFrac }]
      : [];
  }

  const periods = [];
  rows.slice(0, -1).forEach((row, index) => {
    const next = rows[index + 1];
    const startHour = row.hourFrac;
    const endHour = next.hourFrac;
    const span = endHour - startHour;
    if (span <= 0) return;

    const startTemp = row.temp;
    const endTemp = next.temp;
    const slope = endTemp - startTemp;
    let startT = 0;
    let endT = 1;

    if (slope === 0) {
      if (startTemp < lowerC || startTemp > upperC) return;
    } else {
      const tA = (lowerC - startTemp) / slope;
      const tB = (upperC - startTemp) / slope;
      startT = Math.max(0, Math.min(tA, tB));
      endT = Math.min(1, Math.max(tA, tB));
      if (endT < 0 || startT > 1 || startT > endT) return;
    }

    const start = startHour + span * startT;
    const end = startHour + span * endT;
    if (periods.length && Math.abs(periods[periods.length - 1].end - start) < 0.01) {
      periods[periods.length - 1].end = end;
    } else {
      periods.push({ start, end });
    }
  });

  return periods;
}

function rowDisplayTemp(row) {
  return tempFromCelsius(row.temp, { decimals: 1 });
}

function drawForecastSegment(ctx, rows, xOfHr, yOf, fromHour, toHour) {
  if (toHour <= fromHour) return;

  ctx.beginPath();
  let started = false;
  rows.slice(0, -1).forEach((row, index) => {
    const next = rows[index + 1];
    const start = Math.max(fromHour, row.hourFrac);
    const end = Math.min(toHour, next.hourFrac);
    if (end < start) return;

    const span = next.hourFrac - row.hourFrac;
    if (span <= 0) return;
    const tempAt = (hour) => row.temp + ((hour - row.hourFrac) / span) * (next.temp - row.temp);
    const points = [
      { hour: start, temp: tempAt(start) },
      { hour: end, temp: tempAt(end) },
    ];

    points.forEach((point) => {
      const x = xOfHr(point.hour);
      const y = yOf(tempFromCelsius(point.temp, { decimals: null }));
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
  });

  if (started) ctx.stroke();
}

function updateTemperatureHighlightStatus(forecastRows = getForecastRows()) {
  const status = document.getElementById('targetTempStatus');
  if (!status) return;
  status.classList.remove('match', 'no-match', 'error');
  if (!temperatureHighlight) {
    status.textContent = '';
    return;
  }
  if (temperatureHighlight.error) {
    status.classList.add('error');
    status.textContent = temperatureHighlight.error;
    return;
  }
  if (!forecastRows.length) {
    status.classList.add('no-match');
    status.textContent = 'No forecast data for the selected model';
    return;
  }

  const periods = temperatureHighlightPeriods(forecastRows, temperatureHighlight.lowerC, temperatureHighlight.upperC);
  const targetLabel = `${temperatureHighlight.target}${temperatureHighlight.unit}`;
  if (!periods.length) {
    const minTemp = Math.min(...forecastRows.map((row) => row.temp));
    const maxTemp = Math.max(...forecastRows.map((row) => row.temp));
    status.classList.add('no-match');
    status.textContent = `${targetLabel}: no periods from ${formatTempFromCelsius(temperatureHighlight.lowerC, { decimals: 1 })} to ${formatTempFromCelsius(temperatureHighlight.upperC, { decimals: 1 })}`;
    status.title = `Selected model range today: ${formatTempFromCelsius(minTemp, { decimals: 1 })} to ${formatTempFromCelsius(maxTemp, { decimals: 1 })}`;
    return;
  }
  status.classList.add('match');
  status.title = '';
  status.textContent = `${targetLabel}: ${periods.map((period) => `${formatHourFrac(period.start)}-${formatHourFrac(period.end)}`).join(', ')}`;
}

function setTemperatureHighlight(value) {
  temperatureHighlight = parseTemperatureHighlightInput(value);
  updateTemperatureHighlightStatus();
  drawChart();
}

function clearTemperatureHighlight() {
  temperatureHighlight = null;
  const input = document.getElementById('targetTempInput');
  if (input) input.value = '';
  updateTemperatureHighlightStatus();
  drawChart();
}

async function loadMetar() {
  if (!isTodayForecastSelected()) return;
  const requestCityId = activeCity.id;
  const requestStation = activeCity.metar;
  const requestTimezone = activeCity.timezone;
  const cacheKey = `${requestStation}_${cityTodayKey(requestTimezone)}`;
  const cached = metarCacheByStation[cacheKey];
  if (cached && Date.now() - cached.loadedAt < METAR_CACHE_TTL_MS) {
    metarToday = cached.rows;
    metarObsTime = cached.obsTime;
    updateMetarUI();
    drawChart();
    document.getElementById('metarUpd').textContent = fmtMetarAge(metarObsTime);
    return;
  }

  try {
    if (!metarInflightByStation[requestStation]) {
      metarInflightByStation[requestStation] = fetch(`/api/metar?station=${requestStation}`, { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .finally(() => {
          delete metarInflightByStation[requestStation];
        });
    }

    const payload = await metarInflightByStation[requestStation];
    const raw = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.value)
      ? payload.value
      : [];
    if (requestCityId !== activeCity.id) return;

    const obs = raw
      .filter((row) => row.temp != null)
      .map((row) => {
        const precise = activeCity.usesUsMetarTenths ? parseUsMetarTenths(row.rawOb) : null;
        return {
          time: parseObsDate(row.reportTime ?? row.obsTime),
          temp: precise?.tempC ?? row.temp,
          dewp: precise?.dewpC ?? row.dewp,
          wspd: row.wspd,
          wdir: row.wdir,
          rawOb: row.rawOb,
          weather: parseMetarWeather(row.rawOb),
        };
      })
      .filter((row) => Number.isFinite(row.time.getTime()) && Number.isFinite(row.temp))
      .sort((a, b) => a.time - b.time);

    const todayStr = cityDateStr(new Date());

    metarToday = obs.filter((item) => cityDateStr(item.time) === todayStr);
    metarObsTime = metarToday.length ? metarToday[metarToday.length - 1].time.getTime() : Date.now();
    metarCacheByStation[cacheKey] = {
      rows: metarToday,
      obsTime: metarObsTime,
      loadedAt: Date.now(),
    };
    if (!isTodayForecastSelected()) return;

    document.getElementById('chartTitle').textContent = `${activeCity.metar} Temperature ${forecastDayLabel()}`;
    updateMetarUI();
    drawChart();
    document.getElementById('metarUpd').textContent = fmtMetarAge(metarObsTime);
  } catch (error) {
    console.warn('METAR fetch:', error.message);
    document.getElementById('metarRaw').textContent = 'METAR unavailable';
    drawChart();
  }
}

function parseObsDate(value) {
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return new Date(value);
}

function parseMetarWeather(rawOb) {
  if (!rawOb) return '\u2014';
  const tokens = rawOb.split(' ');

  const wxMap = {
    TSRA: 'thunderstorm with rain',
    TSSN: 'thunderstorm with snow',
    TSGS: 'thunderstorm with hail',
    TS: 'thunderstorm',
    '+RA': 'heavy rain',
    RA: 'rain',
    '-RA': 'light rain',
    '+SN': 'heavy snow',
    SN: 'snow',
    '-SN': 'light snow',
    RASN: 'rain and snow',
    SNRA: 'snow and rain',
    '+DZ': 'heavy drizzle',
    DZ: 'drizzle',
    '-DZ': 'light drizzle',
    FZRA: 'freezing rain',
    FZDZ: 'freezing drizzle',
    '+GR': 'heavy hail',
    GR: 'hail',
    GS: 'small hail',
    BLSN: 'blowing snow',
    DRSN: 'drifting snow',
    FG: 'fog',
    FZFG: 'freezing fog',
    MIFG: 'shallow fog',
    BR: 'mist',
    HZ: 'haze',
    FU: 'smoke',
    DU: 'dust',
    SA: 'sand',
    SQ: 'squalls',
    FC: 'funnel cloud',
  };

  const skyPriority = { FEW: 1, SCT: 2, BKN: 3, OVC: 4 };
  const skyLabel = {
    FEW: 'mostly clear',
    SCT: 'partly cloudy',
    BKN: 'cloudy',
    OVC: 'overcast',
  };

  for (const token of tokens) {
    if (wxMap[token]) return wxMap[token];
  }

  for (const token of tokens) {
    if (/^(SKC|CLR|NSC|NCD|CAVOK)$/.test(token)) return 'clear';
  }

  let bestPriority = 0;
  let bestLabel = null;
  for (const token of tokens) {
    const match = token.match(/^(FEW|SCT|BKN|OVC)\d{3}/);
    if (match && skyPriority[match[1]] > bestPriority) {
      bestPriority = skyPriority[match[1]];
      bestLabel = skyLabel[match[1]];
    }
  }
  return bestLabel || '--';
}

function updateMetarUI() {
  if (!metarToday.length) return;
  const latest = metarToday[metarToday.length - 1];

  document.getElementById('tempNow').innerHTML = `${tempFromCelsius(latest.temp, observedTempOptions())}<span class="temp-unit">${tempUnitLabel()}</span>`;
  document.getElementById('metarRaw').textContent = latest.rawOb;
  document.getElementById('cfWeather').textContent = parseMetarWeather(latest.rawOb);
  document.getElementById('cfWind').textContent =
    (latest.wdir === 'VRB' ? 'VRB' : latest.wdir != null ? `${latest.wdir}\u00B0` : '--') +
    (latest.wspd != null ? ` ${latest.wspd}kt` : '');

  const temps = metarToday.map((item) => item.temp);
  document.getElementById('cfMin').textContent = formatTempFromCelsius(Math.min(...temps), observedTempOptions());
  document.getElementById('cfMax').textContent = formatTempFromCelsius(Math.max(...temps), observedTempOptions());
}

function cityTimeParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: activeCity.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function toHourFrac(date) {
  const parts = cityTimeParts(date);
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
}

function currentCityHourFrac() {
  const parts = cityTimeParts(new Date());
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
}

function drawChart() {
  const canvas = document.getElementById('tempChart');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const forecastRows = getForecastRows();
  const nowHour = currentCityHourFrac();
  const observedToday = isTodayForecastSelected()
    ? metarToday.filter((item) => toHourFrac(item.time) <= nowHour + 0.25)
    : [];

  if (!observedToday.length && !forecastRows.length) {
    ctx.fillStyle = 'rgba(139,146,169,0.4)';
    ctx.font = '12px Inter,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No weather data', width / 2, height / 2);
    return;
  }

  const pad = { top: 14, right: 20, bottom: 28, left: 36 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const xOfHr = (hour) => pad.left + (hour / 24) * chartWidth;

  const displayToday = observedToday.map((item) => tempFromCelsius(item.temp, observedTempOptions()));
  const displayForecast = forecastRows.map(rowDisplayTemp);
  const allTemps = [...displayToday, ...displayForecast].filter((value) => value != null);
  const rawMin = Math.min(...allTemps);
  const rawMax = Math.max(...allTemps);
  const yPad = Math.max(1, Math.round((rawMax - rawMin) * 0.15));
  const yMin = rawMin - yPad;
  const yMax = rawMax + yPad;
  const yRange = Math.max(yMax - yMin, 1);
  const yOf = (value) => pad.top + (1 - (value - yMin) / yRange) * chartHeight;

  ctx.lineWidth = 1;
  const step = rawMax - rawMin <= 6 ? 1 : 2;
  for (let temp = Math.ceil(yMin); temp <= Math.floor(yMax); temp += step) {
    const y = yOf(temp);
    ctx.strokeStyle = 'rgba(37,40,54,0.9)';
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartWidth, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139,146,169,0.55)';
    ctx.font = '10px Inter,system-ui,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${temp}${tempUnitLabel()}`, pad.left - 4, y + 3.5);
  }

  ctx.fillStyle = 'rgba(139,146,169,0.6)';
  ctx.font = '10px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center';
  for (let hour = 0; hour <= 24; hour += 2) {
    const x = xOfHr(hour);
    ctx.fillText(`${hour.toString().padStart(2, '0')}:00`, x, height - pad.bottom + 13);
    ctx.strokeStyle = 'rgba(37,40,54,0.5)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartHeight);
    ctx.stroke();
  }

  if (temperatureHighlight && !temperatureHighlight.error && forecastRows.length) {
    const periods = temperatureHighlightPeriods(forecastRows, temperatureHighlight.lowerC, temperatureHighlight.upperC);

    periods.forEach((period) => {
      const x = xOfHr(period.start);
      const w = Math.max(2, xOfHr(period.end) - x);
      ctx.fillStyle = 'rgba(245,158,11,0.36)';
      ctx.fillRect(x, pad.top, w, chartHeight);

      ctx.fillStyle = 'rgba(245,158,11,0.92)';
      ctx.fillRect(x, pad.top + chartHeight - 9, w, 9);

      ctx.save();
      ctx.strokeStyle = 'rgba(245,158,11,0.92)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartHeight);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + w, pad.top);
      ctx.lineTo(x + w, pad.top + chartHeight);
      ctx.stroke();
      ctx.restore();

      if (w >= 38) {
        ctx.fillStyle = '#0d0f14';
        ctx.font = 'bold 10px Inter,system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${formatHourFrac(period.start)}-${formatHourFrac(period.end)}`, x + w / 2, pad.top + chartHeight - 13);
      }
    });

    if (periods.length) {
      const labelX = Math.min(pad.left + chartWidth - 54, xOfHr(periods[0].start) + 4);
      ctx.fillStyle = '#fde68a';
      ctx.font = 'bold 10px Inter,system-ui,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${temperatureHighlight.target}${temperatureHighlight.unit}`, labelX, pad.top + 11);
    }
  }

  updateTemperatureHighlightStatus(forecastRows);

  const nowX = xOfHr(nowHour);
  if (isTodayForecastSelected() && nowX >= pad.left && nowX <= pad.left + chartWidth) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(231,235,244,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(nowX, pad.top);
    ctx.lineTo(nowX, pad.top + chartHeight);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(231,235,244,0.55)';
    ctx.font = '10px Inter,system-ui,sans-serif';
    ctx.textAlign = nowX > width - 52 ? 'right' : 'left';
    ctx.fillText('now', nowX + (ctx.textAlign === 'left' ? 5 : -5), pad.top + 10);
  }

  if (forecastRows.length) {
    const rMax = Math.max(0.5, ...forecastRows.map((row) => row.rain || 0));
    const rainH = chartHeight * 0.18;
    const rainBase = pad.top + chartHeight;
    const barW = Math.max(2, chartWidth / 48);

    forecastRows.forEach((row) => {
      if ((row.rain || 0) <= 0) return;
      const x = xOfHr(row.hourFrac) - barW / 2;
      const barHeight = Math.min((row.rain / rMax) * rainH, rainH);
      ctx.fillStyle = 'rgba(96,165,250,0.24)';
      ctx.fillRect(x, rainBase - barHeight, barW, barHeight);
    });

    if (forecastRows.length >= 2) {
      ctx.save();
      ctx.setLineDash([8, 5]);
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      forecastRows.forEach((row, index) => {
        const x = xOfHr(row.hourFrac);
        const y = yOf(tempFromCelsius(row.temp, { decimals: 1 }));
        index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();

      forecastRows.forEach((row) => {
        if (Math.round(row.hourFrac) % 3 !== 0 || Math.abs(row.hourFrac - Math.round(row.hourFrac)) > 0.01) return;
        const x = xOfHr(row.hourFrac);
        const y = yOf(tempFromCelsius(row.temp, { decimals: 1 }));
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#60a5fa';
        ctx.fill();
        ctx.strokeStyle = 'rgba(13,15,20,0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      if (temperatureHighlight && !temperatureHighlight.error) {
        const periods = temperatureHighlightPeriods(forecastRows, temperatureHighlight.lowerC, temperatureHighlight.upperC);
        ctx.save();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        periods.forEach((period) => drawForecastSegment(ctx, forecastRows, xOfHr, yOf, period.start, period.end));
        ctx.restore();
      }
    }
  }

  if (observedToday.length >= 1) {
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartHeight);
    gradient.addColorStop(0, 'rgba(249,115,22,0.30)');
    gradient.addColorStop(0.7, 'rgba(249,115,22,0.06)');
    gradient.addColorStop(1, 'rgba(249,115,22,0)');

    ctx.beginPath();
    observedToday.forEach((item, index) => {
      const x = xOfHr(toHourFrac(item.time));
      const y = yOf(tempFromCelsius(item.temp, observedTempOptions()));
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const lastX = xOfHr(toHourFrac(observedToday[observedToday.length - 1].time));
    const firstX = xOfHr(toHourFrac(observedToday[0].time));
    ctx.lineTo(lastX, pad.top + chartHeight);
    ctx.lineTo(firstX, pad.top + chartHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f97316';
    ctx.lineJoin = 'round';
    observedToday.forEach((item, index) => {
      const x = xOfHr(toHourFrac(item.time));
      const y = yOf(tempFromCelsius(item.temp, observedTempOptions()));
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    for (const item of observedToday) {
      const minutes = item.time.getMinutes();
      if (minutes !== 0 && minutes !== 30) continue;
      const x = xOfHr(toHourFrac(item.time));
      const y = yOf(tempFromCelsius(item.temp, observedTempOptions()));
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f97316';
      ctx.fill();
    }

    const latest = observedToday[observedToday.length - 1];
    const latestX = xOfHr(toHourFrac(latest.time));
    const latestDisplay = tempFromCelsius(latest.temp, observedTempOptions());
    const latestY = yOf(latestDisplay);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Inter,system-ui,sans-serif';
    ctx.textAlign = latestX > width - pad.right - 40 ? 'right' : 'left';
    ctx.fillText(`${latestDisplay}${tempUnitLabel()}`, latestX + (ctx.textAlign === 'left' ? 6 : -6), latestY - 6);
  }

  const overlay = document.getElementById('tempChartOverlay');
  overlay.width = width * dpr;
  overlay.height = height * dpr;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;

  chartState = { PAD: pad, cW: chartWidth, cH: chartHeight, W: width, H: height, xOfHr, yOf, dpr, forecastRows, observedToday };
}

function buildLegend() {
  document.getElementById('chartLegend').innerHTML =
    '<div class="legend-item"><div class="legend-dot" style="background:#f97316"></div><span>METAR</span></div>' +
    '<div class="legend-item"><div class="legend-dot" style="background:#60a5fa;border-top:2px dashed #60a5fa;height:0"></div><span>Forecast</span></div>' +
    '<div class="legend-item"><div class="legend-dot" style="background:rgba(96,165,250,0.35);height:8px"></div><span>Rain</span></div>';
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 80);
});

function setupChartMouse() {
  const overlay = document.getElementById('tempChartOverlay');
  const tooltip = document.getElementById('chartTooltip');

  overlay.addEventListener('mousemove', (event) => {
    if (!chartState) return;
    const { PAD, cW, cH, W, xOfHr, yOf, dpr, forecastRows, observedToday } = chartState;

    const rect = overlay.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const hoverHr = ((mouseX - PAD.left) / cW) * 24;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (mouseX < PAD.left || mouseX > PAD.left + cW || mouseY < PAD.top || mouseY > PAD.top + cH) {
      tooltip.classList.remove('visible');
      return;
    }

    let nearestObserved = null;
    let minDistObserved = Infinity;
    for (const item of observedToday || []) {
      const dist = Math.abs(toHourFrac(item.time) - hoverHr);
      if (dist < minDistObserved) {
        minDistObserved = dist;
        nearestObserved = item;
      }
    }

    let nearestForecast = null;
    let minDistForecast = Infinity;
    for (const item of forecastRows || []) {
      const dist = Math.abs(item.hourFrac - hoverHr);
      if (dist < minDistForecast) {
        minDistForecast = dist;
        nearestForecast = item;
      }
    }

    const observedCandidate = nearestObserved && minDistObserved <= 0.6 ? nearestObserved : null;
    const forecastCandidate = nearestForecast && minDistForecast <= 0.6 ? nearestForecast : null;

    if (!observedCandidate && !forecastCandidate) {
      tooltip.classList.remove('visible');
      return;
    }

    const selectedX = xOfHr(forecastCandidate?.hourFrac ?? toHourFrac(observedCandidate.time));

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(selectedX, PAD.top);
    ctx.lineTo(selectedX, PAD.top + cH);
    ctx.stroke();
    ctx.setLineDash([]);

    if (observedCandidate) {
      const x = xOfHr(toHourFrac(observedCandidate.time));
      const y = yOf(tempFromCelsius(observedCandidate.temp, observedTempOptions()));
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#f97316';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (forecastCandidate) {
      const x = xOfHr(forecastCandidate.hourFrac);
      const y = yOf(tempFromCelsius(forecastCandidate.temp, { decimals: 1 }));
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#60a5fa';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();

    const labelHour = Math.max(0, Math.min(23, Math.round(hoverHr)));
    document.getElementById('ttTime').textContent = `${labelHour.toString().padStart(2, '0')}:00 ${activeCity.name}`;

    document.getElementById('ttMetarTemp').textContent = observedCandidate
      ? formatTempFromCelsius(observedCandidate.temp, observedTempOptions())
      : '--';
    document.getElementById('ttMetarNote').textContent = observedCandidate
      ? (observedCandidate.weather || 'observed')
      : 'no observation near this time';

    document.getElementById('ttForecastTemp').textContent = forecastCandidate
      ? formatTempFromCelsius(forecastCandidate.temp, { decimals: 1 })
      : '--';
    document.getElementById('ttForecastNote').textContent = forecastCandidate
      ? (forecastCandidate.rain > 0
        ? `${forecastCandidate.rain.toFixed(1)} mm rain · ${forecastCandidate.sourceLabel}`
        : forecastCandidate.sourceLabel)
      : 'no forecast point near this time';

    const tipW = 180;
    let tipX = mouseX + 14;
    let tipY = mouseY - 44;
    if (tipX + tipW > W) tipX = mouseX - tipW - 14;
    if (tipY < 4) tipY = mouseY + 14;

    tooltip.style.left = `${tipX}px`;
    tooltip.style.top = `${tipY}px`;
    tooltip.classList.add('visible');
  });

  overlay.addEventListener('mouseleave', () => {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    tooltip.classList.remove('visible');
  });
}
