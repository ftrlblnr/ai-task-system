import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? 'owner@example.com';
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'change-me-please';

  const owner = await prisma.employee.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      fullName: 'Руководитель',
      email: ownerEmail,
      passwordHash: await bcrypt.hash(ownerPassword, 12),
      role: Role.OWNER,
      isProfileAdmin: true,
    },
  });

  console.log(`Готово. Руководитель: ${owner.email} / пароль см. SEED_OWNER_PASSWORD (или "change-me-please" по умолчанию — смените после первого входа).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
