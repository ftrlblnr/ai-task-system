import { IsString } from 'class-validator';

// ExtractedFact — "мягкий" слой фактов, не укладывающихся в leg/event/
// stay/contact (виза, бюджет и т.п.). Ручное создание — тот же уровень
// доверия, что и у остальных ручных правок (пишется напрямую, не через
// ProposedChange — раздел про урезанную схему и "мягкий" слой в
// trip-compose.ts).
export class CreateExtractedFactDto {
  @IsString()
  factKey: string;

  @IsString()
  factValue: string;
}
