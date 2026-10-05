'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardCalendarSection, DashboardOverview, DashboardReceptionSection, DashboardTasksSection } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 14) — state machine
// обновления данных: автообновление 60с только на видимой вкладке,
// ручное обновление не теряет последние данные, устаревший ответ не
// перезаписывает более свежий (generationRef), клиентский таймаут на
// запрос, кеш по разделу переживает ошибку ОДНОГО раздела (другие два
// остаются рабочими — независимость источников).
const AUTO_REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
export const STALE_AFTER_MS = 120_000;

interface SectionState<T> {
  data: T | null;
  fetchedAt: string | null;
  error: string | null;
}

function initialSection<T>(): SectionState<T> {
  return { data: null, fetchedAt: null, error: null };
}

export function useDashboardOverview() {
  const [tasks, setTasks] = useState<SectionState<DashboardTasksSection>>(initialSection);
  const [reception, setReception] = useState<SectionState<DashboardReceptionSection>>(initialSection);
  const [calendar, setCalendar] = useState<SectionState<DashboardCalendarSection>>(initialSection);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Комбинированная метка «Обновлено» — только когда ВСЕ ТРИ раздела
  // отработали ok в одном и том же цикле (раздел 14 ТЗ).
  const [allFreshAt, setAllFreshAt] = useState<string | null>(null);

  const generationRef = useRef(0);
  const lastFetchStartRef = useRef(0);

  const fetchOverview = useCallback(() => {
    const generation = ++generationRef.current;
    setRefreshing(true);
    lastFetchStartRef.current = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    api
      .get<DashboardOverview>('/dashboard/overview', controller.signal)
      .then((res) => {
        if (generation !== generationRef.current) return; // устаревший ответ — отброшен

        // Локальные const — сужение discriminated union по res.tasks.status
        // ненадёжно через вложенный доступ к свойству объекта-параметра,
        // надёжно только на локальной переменной.
        const tasksSection = res.tasks;
        const receptionSection = res.reception;
        const calendarSection = res.calendar;

        if (tasksSection.status === 'ok') setTasks({ data: tasksSection, fetchedAt: tasksSection.fetchedAt, error: null });
        else setTasks((prev) => ({ ...prev, error: tasksSection.message }));

        if (receptionSection.status === 'ok') setReception({ data: receptionSection, fetchedAt: receptionSection.fetchedAt, error: null });
        else setReception((prev) => ({ ...prev, error: receptionSection.message }));

        if (calendarSection.status === 'ok') setCalendar({ data: calendarSection, fetchedAt: calendarSection.fetchedAt, error: null });
        else setCalendar((prev) => ({ ...prev, error: calendarSection.message }));

        setAllFreshAt(
          tasksSection.status === 'ok' && receptionSection.status === 'ok' && calendarSection.status === 'ok' ? res.generatedAt : null,
        );
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        // Весь запрос упал (сеть/таймаут) — помечаем ошибкой все три
        // раздела, НЕ теряя уже показанные данные (раздел 14 ТЗ).
        const message = err instanceof ApiError ? err.message : 'Данные недоступны';
        setTasks((prev) => ({ ...prev, error: message }));
        setReception((prev) => ({ ...prev, error: message }));
        setCalendar((prev) => ({ ...prev, error: message }));
        setAllFreshAt(null);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (generation !== generationRef.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    fetchOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один запуск на монтирование, fetchOverview стабильна (useCallback, [])
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchOverview();
    }, AUTO_REFRESH_MS);

    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchStartRef.current > AUTO_REFRESH_MS) {
        fetchOverview();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchOverview]);

  return { tasks, reception, calendar, loading, refreshing, allFreshAt, refresh: fetchOverview };
}

export function isStale(fetchedAt: string | null): boolean {
  if (!fetchedAt) return false;
  return Date.now() - new Date(fetchedAt).getTime() > STALE_AFTER_MS;
}

export function formatFetchedAt(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
