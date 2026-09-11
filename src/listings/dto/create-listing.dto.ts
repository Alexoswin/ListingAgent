import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import {
  CATEGORY_SUBCATEGORIES,
  Category,
  Subcategory,
} from '../enums/category.enum';

/** Rejects a subcategory that doesn't belong to the DTO's own `category`. */
function IsSubcategoryOfCategory(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSubcategoryOfCategory',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args) {
          if (value === undefined) {
            return true;
          }
          const category = (args?.object as CreateListingDto).category;
          return (
            CATEGORY_SUBCATEGORIES[category]?.includes(
              value as Subcategory,
            ) ?? false
          );
        },
        defaultMessage(args) {
          const category = (args?.object as CreateListingDto).category;
          return `subcategory must be one of [${CATEGORY_SUBCATEGORIES[category]?.join(', ')}] for category "${category}"`;
        },
      },
    });
  };
}

export class CreateListingDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  desc?: string;

  @IsNumber()
  @IsPositive()
  price: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  originalPrice?: number;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  yearPurchased?: string;

  @IsOptional()
  @IsObject()
  specs?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  conditionDetails?: Record<string, unknown>;

  @IsEnum(Category)
  category: Category;

  @IsOptional()
  @IsEnum(Subcategory)
  @IsSubcategoryOfCategory()
  subcategory?: Subcategory;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUrl({}, { each: true })
  imageUrls?: string[];
}
