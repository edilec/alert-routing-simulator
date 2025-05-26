export class TimezoneConversionError extends Error {
  constructor() {
    super('The timezone could not be converted at this instant.')
    this.name = 'TimezoneConversionError'
  }
}

function localMinute(instant, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-nu-latn', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    const parts = formatter.formatToParts(new Date(instant))
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new TimezoneConversionError()
    }
    return hour * 60 + minute
  } catch {
    throw new TimezoneConversionError()
  }
}

function configuredMinute(text) {
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
}

export function isQuietAt(windows, instant) {
  let quiet = false
  for (const window of windows) {
    const minute = localMinute(instant, window.timeZone)
    const start = configuredMinute(window.start)
    const end = configuredMinute(window.end)
    if (start < end ? minute >= start && minute < end : minute >= start || minute < end) quiet = true
  }
  return quiet
}
