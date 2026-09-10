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
}
