'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth-context';

// Фото сотрудников (владелец 22.10.2026): карта «id → /avatars/<key>»
// грузится один раз после входа, <Avatar id=…> берёт фото отсюда, без
// фото — инициалы, как раньше.

interface AvatarsContextValue {
  urls: Record<string, string>;
  setOwn: (employeeId: string, photoUrl: string | null) => void;
}

const AvatarsContext = createContext<AvatarsContextValue>({ urls: {}, setOwn: () => undefined });

export function AvatarsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!userId) return;
    api
      .get<Record<string, string>>('/avatars')
      .then(setUrls)
      .catch(() => undefined);
  }, [userId]);

  const setOwn = useCallback((employeeId: string, photoUrl: string | null) => {
    setUrls((prev) => {
      const next = { ...prev };
      if (photoUrl) next[employeeId] = photoUrl;
      else delete next[employeeId];
      return next;
    });
  }, []);

  return <AvatarsContext.Provider value={{ urls, setOwn }}>{children}</AvatarsContext.Provider>;
}

export function useAvatars(): AvatarsContextValue {
  return useContext(AvatarsContext);
}

// Квадрат по центру, 256×256 JPEG — десятки КБ вместо мегабайтов с камеры.
export async function squareAvatar(file: File, size = 256): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось открыть картинку'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать картинку');
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось обработать картинку'))), 'image/jpeg', 0.88),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
