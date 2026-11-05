<script setup lang="ts">
const props = defineProps<{
  points: { date: string, pnlKrw: number, buyHoldKrw: number | null }[]
}>()

const W = 800
const H = 240
const PAD = 8

const view = computed(() => {
  const pts = props.points
  const values = pts.flatMap(p => (p.buyHoldKrw === null ? [p.pnlKrw] : [p.pnlKrw, p.buyHoldKrw]))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const span = max - min || 1
  const x = (i: number) => PAD + (i / Math.max(1, pts.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD)
  const line = (get: (p: typeof pts[number]) => number | null) =>
    pts.map((p, i) => [i, get(p)] as const).filter(([, v]) => v !== null).map(([i, v]) => `${x(i).toFixed(1)},${y(v!).toFixed(1)}`).join(' ')
  return { strategy: line(p => p.pnlKrw), buyHold: line(p => p.buyHoldKrw), zero: y(0), min, max }
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <svg :viewBox="`0 0 ${W} ${H}`" class="h-60 w-full" preserveAspectRatio="none" data-testid="equity-chart">
      <line :x1="PAD" :x2="W - PAD" :y1="view.zero" :y2="view.zero" class="stroke-border" stroke-dasharray="4 4" />
      <polyline :points="view.buyHold" fill="none" class="stroke-muted-foreground" stroke-width="1.5" vector-effect="non-scaling-stroke" />
      <polyline :points="view.strategy" fill="none" class="stroke-primary" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="flex justify-between text-xs text-muted-foreground">
      <span>{{ formatYmd(points[0]?.date) }}</span>
      <span class="flex gap-4">
        <span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-primary" />전략</span>
        <span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-muted-foreground" />그냥 보유</span>
        <span>범위 {{ formatMoney(view.min) }} ~ {{ formatMoney(view.max) }}</span>
      </span>
      <span>{{ formatYmd(points.at(-1)?.date) }}</span>
    </div>
  </div>
</template>
