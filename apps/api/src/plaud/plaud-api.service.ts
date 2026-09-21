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

  // Stage 2, Phase K (внешний аудит 21.09.2026, "MeetingSegment +
  // transcript ingestion") — ⚠️ НЕ ПОДТВЕРЖДЕНО живым вызовом API в этой
  // сессии, в отличие от 'auto_sum_note' (тот был явно проверен чтением
  // исходников @plaud-ai/cli, см. комментарий класса выше — этот пакет
  // недоступен в данном окружении, свериться было не с чем). Значения
  // data_type ниже — best-effort предположение по аналогии с другими
  // AI-транскрипцией сервисами (raw ASR-транскрипт как отдельный "note",
  // параллельный auto_sum_note). Прежде чем полагаться на это в проде —
  // нужно подключить реальный Plaud-аккаунт с готовой записью и свериться
  // с фактическим note_list в ответе GET /files/:id.
  findTranscriptNote(detail: PlaudFileDetail): PlaudNote | undefined {
    const candidates = ['origin_text_note', 'transcript_note', 'origin_note'];
    return detail.note_list?.find((note) => candidates.includes(note.data_type));
  }
}
