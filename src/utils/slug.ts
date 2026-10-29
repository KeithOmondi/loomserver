// src/utils/slug.ts

/**
 * Generate a URL-friendly slug from a string
 * Example: "My Awesome Product!" → "my-awesome-product"
 */
export const generateSlug = (text: string): string => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    // Replace spaces with hyphens
    .replace(/\s+/g, '-')
    // Remove special characters
    .replace(/[^\w\-]+/g, '')
    // Remove multiple hyphens
    .replace(/\-\-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+/, '')
    .replace(/-+$/, '');
};

/**
 * Generate a unique slug by appending a number if the slug already exists
 */
export const generateUniqueSlug = async (
  name: string,
  existingSlug?: string,
  getExistingSlugs?: (slug: string) => Promise<boolean>
): Promise<string> => {
  let slug = generateSlug(name);
  
  // If we have an existing slug and it's the same, return it
  if (existingSlug && slug === existingSlug) {
    return slug;
  }
  
  let uniqueSlug = slug;
  let counter = 1;
  
  // If no check function provided, just return the slug
  if (!getExistingSlugs) {
    return slug;
  }
  
  while (await getExistingSlugs(uniqueSlug)) {
    uniqueSlug = `${slug}-${counter}`;
    counter++;
  }
  
  return uniqueSlug;
};