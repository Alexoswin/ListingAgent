export enum Category {
  Electronics = 'electronics',
  Furniture = 'furniture',
  HomeAppliances = 'home-appliances',
}

export enum Subcategory {
  Laptops = 'Laptops',
  Phones = 'Phones',
  Sofas = 'Sofas',
  Beds = 'Beds',

  Fridges = 'Fridges',
  AirCoolers = 'Air Coolers',
}

export const CATEGORY_SUBCATEGORIES: Record<Category, Subcategory[]> = {
  [Category.Electronics]: [
    Subcategory.Laptops,
    Subcategory.Phones,

  ],
  [Category.Furniture]: [
    Subcategory.Sofas,
    Subcategory.Beds,
 
  ],
  [Category.HomeAppliances]: [Subcategory.Fridges, Subcategory.AirCoolers],
};
