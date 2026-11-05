<script setup lang="ts">
defineProps<{
  results: {
    symbol: string
    bars: number
    firstDate: string | null
    lastDate: string | null
    warnings: string[]
    metrics: {
      pnlKrw: string
      returnPct: string
      buyHoldReturnPct: string | null
      maxDrawdownPct: string
      trades: number
      winRatePct: string | null
    }
  }[]
  runId?: number
  selected?: number
}>()
const emit = defineEmits<{ select: [index: number] }>()
</script>

<template>
  <table class="w-full text-sm" data-testid="backtest-results">
    <thead class="text-left text-muted-foreground">
      <tr class="border-b">
        <th class="py-2">
          종목
        </th>
        <th>기간</th>
        <th class="text-right">
          전략 수익률
        </th>
        <th class="text-right">
          그냥 보유
        </th>
        <th class="text-right">
          최대 낙폭
        </th>
        <th class="text-right">
          거래
        </th>
        <th class="text-right">
          승률
        </th>
        <th class="text-right">
          손익
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(r, i) in results"
        :key="r.symbol"
        class="cursor-pointer border-b last:border-0 hover:bg-muted/50"
        :class="selected === i ? 'bg-muted' : ''"
        @click="runId ? navigateTo(`/backtests/${runId}`) : emit('select', i)"
      >
        <td class="py-2 font-medium">
          {{ r.symbol }}
          <span v-if="r.warnings.length" class="ml-1 text-amber-600" :title="r.warnings.join('\n')">!</span>
        </td>
        <td class="whitespace-nowrap text-muted-foreground">
          {{ formatYmd(r.firstDate) }} ~ {{ formatYmd(r.lastDate) }} ({{ r.bars }}일)
        </td>
        <td class="text-right font-medium" :class="pnlClass(r.metrics.returnPct)">
          {{ formatPct(r.metrics.returnPct) }}
        </td>
        <td class="text-right" :class="pnlClass(r.metrics.buyHoldReturnPct)">
          {{ formatPct(r.metrics.buyHoldReturnPct) }}
        </td>
        <td class="text-right">
          -{{ r.metrics.maxDrawdownPct }}%
        </td>
        <td class="text-right">
          {{ r.metrics.trades }}
        </td>
        <td class="text-right">
          {{ r.metrics.winRatePct === null ? '-' : `${r.metrics.winRatePct}%` }}
        </td>
        <td class="text-right" :class="pnlClass(r.metrics.pnlKrw)">
          {{ formatMoney(r.metrics.pnlKrw) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>
