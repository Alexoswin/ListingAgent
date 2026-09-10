export enum Category {
  Electronics = 'electronics',
  Furniture = 'furniture',
  HomeAppliances = 'home-appliances',
}

export enum Subcategory {
  Laptops = 'Laptops',
  Phones = 'Phones',
  Headphones = 'Headphones',
  OtherTech = 'Other Tech',
  Sofas = 'Sofas',
  Beds = 'Beds',
  Wardrobes = 'Wardrobes',
  CoffeeTables = 'Coffee Tables',
  HomeDecor = 'Home Decor',
  Fridges = 'Fridges',
  AirCoolers = 'Air Coolers',
}

export const CATEGORY_SUBCATEGORIES: Record<Category, Subcategory[]> = {
  [Category.Electronics]: [
    Subcategory.Laptops,
    Subcategory.Phones,
    Subcategory.Headphones,
    Subcategory.OtherTech,
  ],
  [Category.Furniture]: [
    Subcategory.Sofas,
    Subcategory.Beds,
    Subcategory.Wardrobes,
    Subcategory.CoffeeTables,
    Subcategory.HomeDecor,
  ],
  [Category.HomeAppliances]: [Subcategory.Fridges, Subcategory.AirCoolers],
};
