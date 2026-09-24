import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateLiveSessionDto {
  // WebRTC SDP offer браузера — сервер обменивает его на answer у OpenAI.
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  sdp!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  conversationId?: string;
}
