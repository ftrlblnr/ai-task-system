import { MailActionGroupType } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsString, Min } from 'class-validator';

// Раздел 7/14 ТЗ — согласие привязано к ТОЧНОМУ набору ID пунктов ОДНОЙ
// группы + версии плана на момент согласия (planVersion). Три группы +
// корзина — каждая своя кнопка на фронте, по одному запросу на группу
// (раздел 7: "Внешняя отправка — отдельная явно названная кнопка").
export class ApproveMailActionGroupDto {
  @IsInt()
  @Min(1)
  planVersion!: number;

  @IsEnum(MailActionGroupType)
  groupType!: MailActionGroupType;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  itemIds!: string[];
}
