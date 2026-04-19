// ──────────────────────────────────────────────
// sensor.js
//  - 조도 센서(BH1750, TSL2561 등)에서 값을 읽어오는 역할.
//  - 하드웨어 연동은 보통 I2C/SPI/ADC 를 통해 이루어지지만,
//    본 보일러플레이트에서는 "가상 값 생성 함수" 로 대체합니다.
//  - 추후 실제 센서 드라이버 라이브러리(i2c-bus 등)로 교체만
//    하면 상위 코드 변경 없이 동작하도록 인터페이스를 분리했습니다.
// ──────────────────────────────────────────────

const buildLogger = require('./logger');
const log = buildLogger('sensor');

/**
 * 가상의 조도값(lux)을 반환합니다.
 *  - 낮과 밤을 흉내내기 위해 시간대에 따라 범위를 달리합니다.
 *    · 06:00 ~ 18:00 : 300 ~ 1000 lux (주간)
 *    · 그 외 시간대   :   0 ~ 200  lux (야간)
 *  - 실제 서비스에서는 이 함수를 I2C 센서 read() 로 교체합니다.
 */
function readIlluminance() {
  try {
    const hour = new Date().getHours();
    const isDaytime = hour >= 6 && hour < 18;

    const min = isDaytime ? 300 : 0;
    const max = isDaytime ? 1000 : 200;

    // 랜덤 float 값 (소수점 2자리)
    const lux = Math.random() * (max - min) + min;
    return Number(lux.toFixed(2));
  } catch (err) {
    // 센서 오작동/통신 오류를 상위로 전달해 적절히 처리하도록 함.
    log.error('조도 센서 읽기 실패:', err.message);
    throw err;
  }
}

module.exports = { readIlluminance };
