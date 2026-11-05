<script setup lang="ts">
const { data: runs } = await useFetch('/api/backtests')
</script>

<template>
  <main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <NuxtLink to="/" class="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← 대시보드
        </NuxtLink>
        <h1 class="text-2xl font-semibold">
          백테스트
        </h1>
      </div>
      <code class="rounded bg-muted px-2 py-1 text-xs">pnpm backtest --symbols 005930,AAPL.OQ --from 2020-01-01</code>
    </header>

    <p v-if="!runs?.length" class="py-12 text-center text-muted-foreground" data-testid="no-runs">
      아직 백테스트 결과가 없어요. 위 명령으로 실행하면 여기에 쌓여요.
    </p>

    <Card v-for="run in runs" :key="run.id" data-testid="run">
      <CardHeader>
        <CardTitle>
          <NuxtLink :to="`/backtests/${run.id}`" class="underline-offset-4 hover:underline">
            #{{ run.id }} · {{ run.params.strategy.toUpperCase() }}({{ run.params.smaShort }}, {{ run.params.smaLong }})
          </NuxtLink>
        </CardTitle>
        <CardDescription>
          {{ formatYmd(run.params.from) }} ~ {{ formatYmd(run.params.to) }} · 주문 예산 {{ formatMoney(run.params.orderBudgetKrw) }} · 실행 {{ formatTime(run.createdAt) }}
        </CardDescription>
      </CardHeader>
      <CardContent class="overflow-x-auto">
        <BacktestTable :run-id="run.id" :results="run.results" />
      </CardContent>
    </Card>
  </main>
</template>
