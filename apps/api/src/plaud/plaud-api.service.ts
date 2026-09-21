import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PlaudOAuthService } from './plaud-oauth.service';

const API_BASE = 'https://platform.plaud.ai/developer/api';

export interface PlaudFileListItem {
  id: string;
  name: string;
  created_at: string;
  duration?: number;
}

export interface PlaudFileListResponse {
  data: PlaudFileListItem[];
}

export interface PlaudNote {
  data_type: string;
  data_content?: string;
  data_link?: string;
  data_title?: string;
  data_tab_name?: string;
  data_error_code?: number | string;
  download_link_map?: Record<string, string>;
}

export interface PlaudFileDetail {
  id: string;
  name: string;
  created_at: string;
  note_list: PlaudNote[];
  // Stage 2, Phase M (21.09.2026) — подтверждено живым вызовом реального
  // GET /files/:id на подключённом проде: транскрипт лежит именно здесь
  // (data_type: 'transaction'/'transaction_polish'), не в note_list (см.
  // findTranscriptNote ниже). Та же форма элемента, что PlaudNote — те же
  // поля data_id/data_type/data_content/data_link на практике.
  source_list?: PlaudNote[];
}

// Тонкая обёртка над Plaud REST — без SDK, тот же стиль, что и
// TelegramBotService (прямой fetch). Эндпоинты и форма ответов подтверждены
// чтением исходников @plaud-ai/cli (см. plaud-oauth.service.ts).
@Injectable()
export class PlaudApiService {
  constructor(private readonly oauth: PlaudOAuthService) {}

  private async request<T>(employeeId: string, path: string): Promise<T> {
    const accessToken = await this.oauth.getAccessToken(employeeId);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new UnauthorizedException(`Запрос к Plaud API не удался: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async listFiles(employeeId: string, page: number, pageSize: number): Promise<PlaudFileListResponse> {
    return this.request<PlaudFileListResponse>(employeeId, `/open/third-party/files/?page=${page}&page_size=${pageSize}`);
  }

  async getFile(employeeId: string, fileId: string): Promise<PlaudFileDetail> {
    return this.request<PlaudFileDetail>(employeeId, `/open/third-party/files/${fileId}`);
  }

  // note_list.data_content обычно уже содержит готовый markdown; пусто —
  // фолбэк на presigned S3-ссылку (data_link), она отдаётся простым
  // неавторизованным GET.
  async loadNoteContent(note: PlaudNote): Promise<string> {
    if (note.data_content) return note.data_content;
    if (note.data_link) {
      const res = await fetch(note.data_link);
      if (res.ok) return res.text();
    }
    return '';
  }

  // Stage 2, Phase M (внешний аудит 21.09.2026, находка "Plaud transcript
  // может читаться не из того поля") — ПОДТВЕРЖДЕНО живым вызовом реального
  // GET /files/:id на боевом подключённом аккаунте 21.09.2026: транскрипт
  // лежит в detail.source_list, НЕ в note_list (прежняя догадка Phase K
  // была основана на аналогии с другими ASR-сервисами, без подтверждения —
  // она оказалась неверной, source_list вообще отдельный top-level массив).
  // Реальная структура одной записи:
  //   source_list: [
  //     { data_type: 'transaction',        data_content: '[{...сегменты}]' },
  //     { data_type: 'transaction_polish', data_content: '' | '[...]' },
  //     { data_type: 'outline',            data_content: '...' },
  //   ]
  // 'transaction_polish' — по всей видимости причёсанная/AI-исправленная
  // версия того же транскрипта (в проверенной записи была пустой, но раз
  // Plaud вообще выделяет для неё отдельный слот — предпочитаем её, если
  // она непустая, иначе берём сырой 'transaction'). note_list оставлен как
  // best-effort фолбэк последним пунктом — на случай если Plaud когда-то
  // отдаст транскрипт и там тоже (не наблюдалось в проверенной записи, но
  // не исключено для других типов записей/тарифов).
  findTranscriptNote(detail: PlaudFileDetail): PlaudNote | undefined {
    const polish = detail.source_list?.find((note) => note.data_type === 'transaction_polish' && note.data_content);
    if (polish) return polish;
    const transaction = detail.source_list?.find((note) => note.data_type === 'transaction');
    if (transaction) return transaction;
    const legacyCandidates = ['origin_text_note', 'transcript_note', 'origin_note'];
    return detail.note_list?.find((note) => legacyCandidates.includes(note.data_type));
  }
}
