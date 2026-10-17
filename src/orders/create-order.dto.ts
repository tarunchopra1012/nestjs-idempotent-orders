import {
  IsNotEmpty,
  IsNumber,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  externalRef: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total: number;
}
