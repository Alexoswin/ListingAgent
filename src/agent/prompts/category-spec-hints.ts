import { Category, Subcategory } from '../../listings/enums/category.enum';

/**
 * Per-category/subcategory guidance for the generation step.
 *
 * This is NOT a validation schema — `specs` and `conditionDetails` stay
 * free-form (see listing.schema.ts). These hints just tell the LLM which
 * spec keys and condition aspects are typically relevant for a given
 * category/subcategory, so extraction stays consistent across listings
 * without hard-coding a closed key set. Any category/subcategory not
 * covered by the enum should fall back to `DEFAULT_HINTS`.
 */

export interface CategoryHints {
  /** Suggested `specifications[].key` values worth looking for. */
  specKeys: string[];
  /** Aspects to check when writing visual/functional condition notes. */
  conditionAspects: string[];
}

export const DEFAULT_HINTS: CategoryHints = {
  specKeys: ['Brand', 'Model'],
  conditionAspects: [
    'Visible wear, scratches, or damage',
    'Missing or damaged parts',
    'Whether it powers on / functions as expected',
    'Included accessories or original packaging',
  ],
};

export const CATEGORY_SPEC_HINTS: Partial<
  Record<Category, Partial<Record<Subcategory, CategoryHints>>>
> = {
  [Category.Electronics]: {
    [Subcategory.Laptops]: {
      specKeys: [
        'Processor',
        'RAM',
        'Storage Type',
        'Storage Capacity',
        'Screen Size',
        'Operating System',
      ],
      conditionAspects: [
        'Scratches, dents, or scuffs on the lid/base',
        'Screen condition (dead pixels, cracks, discoloration)',
        'Keyboard/trackpad wear or missing keys',
        'Battery health / charging behavior',
        'Powers on and boots normally',
        'Charger and original box included',
      ],
    },
    [Subcategory.Phones]: {
      specKeys: [
        'Storage',
        'RAM',
        'Color',
        'SIM Options',
        'Country Variant',
      ],
      conditionAspects: [
        'Screen cracks, scratches, or discoloration',
        'Back panel / frame dents or scratches',
        'Battery health',
        'Face ID / fingerprint / buttons functioning',
        'Original charger, box, and bill included',
        'Prior repair history',
      ],
    },
  },

  [Category.Furniture]: {
    [Subcategory.Sofas]: {
      specKeys: [
        'Sofa Type',
        'Material',
        'Seater Count',
        'Dimensions',
        'Recliner',
      ],
      conditionAspects: [
        'Stains, sagging, tears, or cracks in upholstery',
        'Frame stability and structural integrity',
        'Deep cleaning required',
        'Recliner/mechanism functioning (if applicable)',
      ],
    },
    [Subcategory.Beds]: {
      specKeys: [
        'Material',
        'Size',
        'Storage',
        'Mattress Included',
        'Mattress Type',
        'Mattress Thickness',
      ],
      conditionAspects: [
        'Frame scratches, dents, or structural damage',
        'Mattress stains, sagging, or odor',
        'Signs of bed bugs, termites, or mould',
        'Storage mechanism functioning (if applicable)',
      ],
    },
  },

  [Category.HomeAppliances]: {
    [Subcategory.Fridges]: {
      specKeys: [
        'Capacity (Liters)',
        'Door Type',
        'Star Rating',
      ],
      conditionAspects: [
        'Dents, rust, or scratches on the body',
        'Door seal condition',
        'Cooling performance / major repairs done',
        'Interior condition (shelves, drawers intact)',
      ],
    },
    [Subcategory.AirCoolers]: {
      specKeys: ['Capacity (Litres)'],
      conditionAspects: [
        'Body cracks, dents, or discoloration',
        'Fan/motor functioning normally',
        'Water tank / cooling pad condition',
        'Known repairs or issues',
      ],
    },
  },
};

export function getCategoryHints(
  category?: Category,
  subcategory?: Subcategory,
): CategoryHints {
  const subMap = category ? CATEGORY_SPEC_HINTS[category] : undefined;
  return (subcategory && subMap?.[subcategory]) || DEFAULT_HINTS;
}
