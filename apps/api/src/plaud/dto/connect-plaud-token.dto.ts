import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectPlaudTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
