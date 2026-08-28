const isoTime = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export const supportPolicy = Object.freeze({
  schema: 'shipwitness.support-policy.v1',
  stableMajor: 1,
  stableMinorSupportMonths: 12,
  predecessorMinimumMonths: 6,
  endOfSupportNoticeDays: 90,
  securityFixCoverage: 'current-and-previous-minor',
  developmentReleases: 'evaluation-only'
});

export const releaseSupportStatus = ({ version, releasedAt, endOfSupportAt, now = new Date() }) => {
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!stable) return { channel: 'development', supported: false, status: 'evaluation_only', releasedAt: null, endOfSupportAt: null, reason: '开发版本只用于本地或受控试点，不承诺正式支持周期。' };
  const released = isoTime(releasedAt); const end = isoTime(endOfSupportAt);
  if (!released || !end || end <= released) return { channel: 'stable', supported: false, status: 'metadata_missing', releasedAt: released?.toISOString() || null, endOfSupportAt: end?.toISOString() || null, reason: '稳定版本缺少有效的发布日期或停止支持日期。' };
  const minimumEnd = new Date(released); minimumEnd.setUTCMonth(minimumEnd.getUTCMonth() + supportPolicy.stableMinorSupportMonths);
  if (end < minimumEnd) return { channel: 'stable', supported: false, status: 'support_window_too_short', releasedAt: released.toISOString(), endOfSupportAt: end.toISOString(), reason: `稳定版本支持周期短于 ${supportPolicy.stableMinorSupportMonths} 个月，不能作为正式发布版本。` };
  const supported = end > now;
  return { channel: 'stable', supported, status: supported ? 'supported' : 'end_of_support', releasedAt: released.toISOString(), endOfSupportAt: end.toISOString(), reason: supported ? '当前稳定版本处于支持周期内。' : '当前稳定版本已经停止支持，必须升级后再对外提供服务。' };
};
