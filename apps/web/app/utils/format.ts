export function formatMoney(value: string | number | null | undefined, currency = 'KRW') {
  if (value === null || value === undefined) return '-'
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'KRW' ? 0 : 2,
  }).format(Number(value))
}

export function formatNumber(value: string | number) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(Number(value))
}

export function formatTime(iso: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export function pnlClass(value: string | number | null | undefined) {
  const n = Number(value ?? 0)
  return n > 0 ? 'text-red-600' : n < 0 ? 'text-blue-600' : ''
}
