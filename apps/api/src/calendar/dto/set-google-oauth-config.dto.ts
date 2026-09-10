import { IsNotEmpty, IsString } from 'class-validator';

export class SetGoogleOAuthConfigDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  clientSecret: string;
}
