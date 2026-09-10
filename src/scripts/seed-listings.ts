import 'dotenv/config';
import mongoose from 'mongoose';
import { UserSchema, UserRole } from '../users/schemas/user.schema';
import { ListingSchema } from '../listings/schemas/listing.schema';
import { Category, Subcategory } from '../listings/enums/category.enum';

const categories = [
  { category: Category.Electronics, subcategory: Subcategory.Phones },
  { category: Category.Electronics, subcategory: Subcategory.Laptops },
  { category: Category.Furniture, subcategory: Subcategory.Sofas },
  { category: Category.Furniture, subcategory: Subcategory.Beds },
  { category: Category.HomeAppliances, subcategory: Subcategory.Fridges },
];

const brands = ['Samsung', 'Apple', 'Sony', 'IKEA', 'Trek', 'LG', 'Dell', 'HP'];

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(uri);

  const UserModel = mongoose.model('User', UserSchema);
  const ListingModel = mongoose.model('Listing', ListingSchema);

  const seller = await UserModel.findOneAndUpdate(
    { email: 'dummy.seller@example.com' },
    {
      fullName: 'Dummy Seller',
      email: 'dummy.seller@example.com',
      emailVerified: true,
      role: UserRole.Seller,
      isActive: true,
    },
    { upsert: true, returnDocument: 'after' },
  );

  const listings = Array.from({ length: 20 }).map((_, i) => {
    const { category, subcategory } = categories[i % categories.length];
    const brand = brands[i % brands.length];
    const price = 1000 + i * 250;

    return {
      sellerId: seller._id,
      title: `${brand} ${subcategory.slice(0, -1)} #${i + 1}`,
      desc: `Dummy listing #${i + 1} for testing purposes. Good condition ${subcategory.toLowerCase()} item.`,
      price,
      originalPrice: price + 500,
      brand,
      model: `Model-${i + 1}`,
      yearPurchased: `${2020 + (i % 5)}`,
      specs: { color: 'Black', warranty: `${(i % 3) + 1} year(s)` },
      conditionDetails: { grade: ['Excellent', 'Good', 'Fair'][i % 3] },
      category,
      subcategory,
    };
  });

  await ListingModel.insertMany(listings);

  console.log(
    `Inserted ${listings.length} dummy listings under seller ${seller.email}`,
  );

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
