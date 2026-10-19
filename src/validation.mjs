import { z } from "zod";
const str = (max = 200) => z.string().trim().min(1).max(max),
  optionalText = z.string().trim().max(500).default("");
const amount = z.coerce
  .number()
  .finite()
  .positive()
  .max(9999999999.99)
  .multipleOf(0.01);
const quantity = z.coerce.number().int().min(1).max(1000000),
  nonnegative = z.coerce.number().int().min(0).max(1000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === v;
  }, "Invalid calendar date");
export const schemas = {
  login: z
    .object({
      email: z
        .string()
        .email()
        .max(250)
        .transform((v) => v.toLowerCase()),
      password: z.string().min(1).max(128),
    })
    .strict(),
  shop: z
    .object({
      name: str(),
      owner: str(),
      phone: z
        .string()
        .trim()
        .regex(/^\+?[\d\s-]{8,16}$/),
      city: str(100),
      address: optionalText,
      limit: z.coerce
        .number()
        .finite()
        .min(0)
        .max(9999999999.99)
        .multipleOf(0.01),
      terms: z.coerce.number().int().min(1).max(365),
    })
    .strict(),
  product: z
    .object({
      name: str(),
      strength: optionalText,
      form: str(50),
      manufacturer: str(),
      category: str(100),
      price: amount,
      reorder: nonnegative,
      pack: quantity,
    })
    .strict(),
  supplier: z
    .object({ name: str(), contact: str(40), city: str(100) })
    .strict(),
  receiving: z
    .object({
      supplierId: str(100),
      productId: str(100),
      number: str(100),
      expiry: date,
      qty: quantity,
      cost: amount,
    })
    .strict(),
  order: z
    .object({
      shopId: str(100),
      lines: z
        .array(
          z
            .object({
              productId: str(100),
              qty: quantity,
              bonus: nonnegative.default(0),
              rate: amount,
              discount: z.coerce
                .number()
                .finite()
                .min(0)
                .max(100)
                .multipleOf(0.01)
                .default(0),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  payment: z
    .object({
      shopId: str(100),
      date,
      amount,
      method: z.enum(["Cash", "Bank transfer", "Digital wallet"]),
      reference: optionalText,
    })
    .strict()
    .refine((v) => v.method === "Cash" || v.reference.length > 0, {
      message: "Transaction reference is required",
      path: ["reference"],
    }),
  returned: z
    .object({
      invoiceId: str(100),
      lineId: str(100),
      qty: quantity,
      reason: str(500),
    })
    .strict(),
  settings: z
    .object({
      name: str(),
      phone: optionalText,
      address: optionalText,
      currency: z.literal("PKR"),
      expiryWarning: z.coerce.number().int().min(1).max(365),
    })
    .strict(),
  user: z
    .object({
      email: z
        .string()
        .email()
        .transform((v) => v.toLowerCase()),
      name: str(),
      password: z.string().min(12).max(128),
      role: z.enum(["admin", "accounts", "sales", "warehouse"]),
    })
    .strict(),
  password: z
    .object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(12).max(128),
    })
    .strict(),
};
export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(422)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Check the submitted fields.",
            fields: parsed.error.flatten(),
          },
        });
    req.input = parsed.data;
    next();
  };
}
