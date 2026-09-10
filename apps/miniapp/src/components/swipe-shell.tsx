'use client';

import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { haptic } from '@/lib/telegram';

export interface SwipeScreen {
  key: string;
  label: string;
  content: ReactNode;
}

const AXIS_LOCK_THRESHOLD = 8; // px — сколько нужно сдвинуться, чтобы понять направление жеста
const SWIPE_THRESHOLD_RATIO = 0.22;

// Свайп-навигация между режимами Mini App (раздел 14.2 ТЗ + концепция
// «Адъютант»).
//
// Три независимых фикса, все найдены на реальном тестировании/использовании,
// не в этом браузере:
//
// 1) Touch-события с ручным addEventListener({passive:false}), а не
//    Pointer Events через React-пропсы — внутри WebView Telegram-
//    приложения тап работал, а перетаскивание (pointermove) до JS не
//    долетало. React с версии 17 навешивает синтетические touch-
//    обработчики как passive (нельзя preventDefault), а некоторые
//    встроенные WebView не полностью уважают touch-action: pan-y для
//    partial-значений — из-за этого нативный скролл «съедал» жест раньше,
//    чем код успевал его перехватить. Решение — классический паттерн
//    свайп-каруселей: raw listener + ручной axis-lock (первые ~8px решают
//    горизонталь/вертикаль, вертикаль не трогаем).
//
// 2) (01.09.2026, частично) Ширина трека в vw (100vw × screens.length) и
//    offset через window.innerWidth — vw включает scrollbar, трек оказывался
//    шире и левее контейнера (x уходил в -800px). Заменено на % от
//    родителя — но это лишь СНИЗИЛО масштаб той же проблемы, а не убрало
//    её (см. следующий пункт).
//
// 3) (08.09.2026) Владелец сообщил: "свайп криво работает и вкладки
//    открывают не те вкладки" — на проде трек стабильно давал
//    getBoundingClientRect().x ≈ -358px при transform:translateX(0%)
//    вместо ожидаемых ~8px (край .swipe-viewport). Настоящая причина
//    нашлась не здесь, а в voice-screen.tsx: SwipeShell монтирует ВСЕ
//    экраны сразу (прячет неактивные через transform, не условным
//    рендером), и эффект автоскролла чата внутри экрана «Голос» вызывал
//    scrollEndRef.scrollIntoView(...) при каждом монтировании — в том
//    числе когда «Голос» не активен. scrollIntoView() поднимается по ВСЕЙ
//    цепочке скроллируемых предков, а .swipe-viewport, хоть и
//    overflow:hidden, всё равно программно скроллируется — и получал
//    паразитный scrollLeft≈358px, который никак не связан с
//    translateX-позиционированием трека, но getBoundingClientRect() его
//    учитывает. Пофикшено в voice-screen.tsx (прямой chat.scrollTo()
//    вместо scrollIntoView()) + защитный el.parentElement.scrollLeft=0
//    в applyTransform() ниже на случай повтора той же ошибки где-то ещё.
//    Заодно (уже не для фикса самого бага, а по мотивам находки) ширина
//    трека/экранов и офсет translateX переведены с % на px через реально
//    измеренный containerWidth() — надёжнее, чем полагаться на разрешение
//    процентной ширины у flex-контейнера без явного CSS width.
export function SwipeShell({ screens }: { screens: SwipeScreen[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(0);
  const drag = useRef<{
    startX: number;
    startY: number;
    axis: 'x' | 'y' | null;
  } | null>(null);

  // Только для SSR/самого первого пейнта до гидратации — useLayoutEffect
  // ниже немедленно (до отрисовки браузером) заменяет это на px, см.
  // пункт 3 в комментарии над компонентом.
  const screenPercent = 100 / screens.length;

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Кэш последнего измеренного containerWidth() — обновляется только в
  // relayout() (маунт/ресайз/смена набора экранов), а не на каждый
  // touchmove/pointermove: clientWidth форсирует синхронный reflow, дёргать
  // его на каждый кадр жеста — не бесплатно, а ширина внутри одного жеста
  // не меняется.
  const cwRef = useRef(0);

  function containerWidth(): number {
    return trackRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  }

  function applyTransform(index: number, dxPx: number, animate: boolean) {
    const el = trackRef.current;
    if (!el) return;
    // Защита от повтора того же класса бага (см. пункт 3 в комментарии
    // выше, root cause был в voice-screen.tsx, не здесь): .swipe-viewport
    // технически скроллируемый (overflow:hidden не запрещает программный
    // scrollLeft), и любой будущий scrollIntoView()/focus() внутри СКРЫТОГО
    // экрана снова может выставить там паразитный scrollLeft, ломая это
    // transform-позиционирование. Обнуляем на каждый вызов — дёшево, не
    // требует находить каждый потенциальный источник заранее.
    if (el.parentElement) el.parentElement.scrollLeft = 0;
    el.style.transition = animate ? 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    el.style.transform = `translateX(${-index * cwRef.current + dxPx}px)`;
  }

  // Ширина трека/экранов — в px измеренным значением, не в % (см. пункт 3
  // в комментарии выше). Только на маунт/ресайз/смену набора экранов.
  function relayout() {
    const el = trackRef.current;
    if (!el) return;
    const cw = containerWidth();
    cwRef.current = cw;
    el.style.width = `${cw * screens.length}px`;
    for (const child of el.children) {
      (child as HTMLElement).style.width = `${cw}px`;
    }
    applyTransform(activeIndexRef.current, 0, false);
  }

  // useLayoutEffect, не useEffect — синхронно до отрисовки браузером
  // заменяет процентный SSR-фолбэк на измеренные px, ни одного кадра с
  // потенциально неверной позицией трека не должно быть видно пользователю.
  useLayoutEffect(() => {
    relayout();
    window.addEventListener('resize', relayout);
    return () => window.removeEventListener('resize', relayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens.length]);

  function goTo(index: number) {
    const clamped = Math.max(0, Math.min(screens.length - 1, index));
    if (clamped !== activeIndexRef.current) haptic('light');
    activeIndexRef.current = clamped;
    setActiveIndex(clamped);
    applyTransform(clamped, 0, true);
  }

  useEffect(() => {
    const el = trackRef.current;
    if (!el || screens.length < 2) return;

    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      drag.current = { startX: t.clientX, startY: t.clientY, axis: null };
    }

    function onTouchMove(e: TouchEvent) {
      const d = drag.current;
      if (!d) return;
      const t = e.touches[0];
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;

      if (d.axis === null) {
        if (Math.abs(dx) < AXIS_LOCK_THRESHOLD && Math.abs(dy) < AXIS_LOCK_THRESHOLD) return;
        d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (d.axis === 'y') return; // вертикаль — отдаём нативному скроллу, ничего не делаем

      // Горизонтальный жест подтверждён — блокируем нативный скролл/pull-to-refresh
      // на оставшуюся часть жеста и двигаем трек вручную.
      e.preventDefault();
      applyTransform(activeIndexRef.current, dx, false);
    }

    function onTouchEnd(e: TouchEvent) {
      const d = drag.current;
      drag.current = null;
      if (!d || d.axis !== 'x') return;

      const t = e.changedTouches[0];
      const dx = t.clientX - d.startX;
      const threshold = cwRef.current * SWIPE_THRESHOLD_RATIO;
      if (dx < -threshold) goTo(activeIndexRef.current + 1);
      else if (dx > threshold) goTo(activeIndexRef.current - 1);
      else goTo(activeIndexRef.current);
    }

    // passive: false обязателен — иначе preventDefault() внутри onTouchMove
    // игнорируется браузером/WebView (см. комментарий в шапке файла).
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [screens.length]);

  // Pointer-события — только для мыши (десктоп-браузер при разработке).
  // Тач идёт отдельным путём выше через raw touch-листенеры.
  const mouseDrag = useRef<{ startX: number } | null>(null);

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || screens.length < 2) return;
    mouseDrag.current = { startX: e.clientX };
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !mouseDrag.current) return;
    const dx = e.clientX - mouseDrag.current.startX;
    applyTransform(activeIndexRef.current, dx, false);
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !mouseDrag.current) return;
    const dx = e.clientX - mouseDrag.current.startX;
    mouseDrag.current = null;
    const threshold = cwRef.current * SWIPE_THRESHOLD_RATIO;
    if (dx < -threshold) goTo(activeIndexRef.current + 1);
    else if (dx > threshold) goTo(activeIndexRef.current - 1);
    else goTo(activeIndexRef.current);
  }

  return (
    <div className="app-root">
      {screens.length > 1 && (
        <div className="swipe-header">
          {screens.map((s, i) => (
            <button
              key={s.key}
              className={`swipe-tab ${i === activeIndex ? 'active' : ''}`}
              onClick={() => goTo(i)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="swipe-viewport">
        <div
          ref={trackRef}
          className="swipe-track"
          // transform НЕ зависит от activeIndex сознательно (не "translateX(-${activeIndex...}%)")
          // — иначе React видел бы это как изменившийся style-проп при каждом goTo() и
          // перезаписывал бы им то, что applyTransform() выставил императивно в обход React
          // (найдено 08.09.2026 вместе с багом про scrollLeft — тот же клик "открывал не ту
          // вкладку" ещё и по этой причине). 0% здесь — только SSR/первый-пейнт заглушка,
          // useLayoutEffect тут же (до отрисовки) подставляет реальный px.
          style={{ width: `${screens.length * 100}%`, transform: 'translateX(0%)' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {screens.map((s, i) => (
            <div key={s.key} className="swipe-screen" style={{ width: `${screenPercent}%` }}>
              {/* Владелец 10.09.2026: экраны монтируются все сразу (см. комментарий
                  в шапке файла) и раньше грузили данные один раз через useEffect(load, []),
                  из-за чего, например, список задач не обновлялся после голосового
                  создания задачи, пока не перезапустишь Mini App. active передаётся
                  каждому экрану, чтобы он мог сам решить перезагрузить данные при
                  возвращении на вкладку — не меняет монтирование/анимацию свайпа. */}
              {isValidElement(s.content) ? cloneElement(s.content as ReactElement<{ active?: boolean }>, { active: i === activeIndex }) : s.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
