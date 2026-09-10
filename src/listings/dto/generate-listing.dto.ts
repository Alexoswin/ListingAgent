import { ArrayMaxSize, ArrayMinSize, IsArray, IsUrl } from 'class-validator';
import { CreateListingDto } from './create-listing.dto';

/**
 * Input for the agent-generated flow.
 *
 * Same fields the manual flow collects — the seller's own words are still the
 * starting claim — except photos are required rather than optional. Without an
 * image there is nothing to check a generated listing against, and the agent
 * would escalate every one of them.
 */
export class GenerateListingDto extends CreateListingDto {
  // Initialised so an omitted `imageUrls` fails ArrayMinSize with a clear
  // message rather than tripping the base class's optional declaration.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUrl({}, { each: true })
  imageUrls: string[] = [];
}
