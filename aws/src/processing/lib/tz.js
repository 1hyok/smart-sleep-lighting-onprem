'use strict';

/** Fitbit 로컬 시각 문자열(TZ 없음)을 UTC ISO로 변환 */
function fitbitLocalToUtc(localIso, offsetHours = 9) {
  if (!localIso) return null;
  if (localIso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(localIso)) {
    return new Date(localIso).toISOString();
  }
  const normalized = localIso.replace(/\.\d{3}$/, '');
  const sign = offsetHours >= 0 ? '+' : '-';
  const abs = Math.abs(offsetHours);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
  return new Date(`${normalized}${sign}${hh}:${mm}`).toISOString();
}

function shiftIsoUtc(isoUtc, deltaMs) {
  return new Date(new Date(isoUtc).getTime() + deltaMs).toISOString();
}

module.exports = { fitbitLocalToUtc, shiftIsoUtc };
