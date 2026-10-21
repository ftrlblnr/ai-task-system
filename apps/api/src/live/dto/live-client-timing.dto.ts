import { IsInt, Max, Min } from 'class-validator';

// Шаги подключения живого голоса в браузере, мс (журнал AiCall, live.client).
const MAX_MS = 120_000;

export class LiveClientTimingDto {
  @IsInt()
  @Min(0)
  @Max(MAX_MS)
  micMs!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MS)
  iceMs!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MS)
  requestMs!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MS)
  startMs!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MS)
  totalMs!: number;
}
