import { Collection, LoadStrategy, MikroORM, QueryOrder } from '@mikro-orm/sqlite';
import {
  Entity,
  ManyToMany,
  ManyToOne,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { vi } from 'vitest';

describe('polymorphic M:N with composite keys on owner side (fixed)', () => {

  @Entity()
  class Article {

    @PrimaryKey()
    tenantId!: number;

    @PrimaryKey()
    articleId!: number;

    @Property()
    title!: string;

    @ManyToMany(() => Category, c => c.articles, {
      pivotTable: 'categorizables',
      discriminator: 'categorizable',
      owner: true,
    })
    categories = new Collection<Category>(this);

    constructor(tenantId: number, articleId: number, title: string) {
      this.tenantId = tenantId;
      this.articleId = articleId;
      this.title = title;
    }

  }

  @Entity()
  class Product {

    @PrimaryKey()
    tenantId!: number;

    @PrimaryKey()
    productId!: number;

    @Property()
    name!: string;

    @ManyToMany(() => Category, c => c.products, {
      pivotTable: 'categorizables',
      discriminator: 'categorizable',
      owner: true,
    })
    categories = new Collection<Category>(this);

    constructor(tenantId: number, productId: number, name: string) {
      this.tenantId = tenantId;
      this.productId = productId;
      this.name = name;
    }

  }

  @Entity()
  class Category {

    @PrimaryKey()
    id!: number;

    @Property()
    name!: string;

    @ManyToMany(() => Article, a => a.categories)
    articles = new Collection<Article>(this);

    @ManyToMany(() => Product, p => p.categories)
    products = new Collection<Product>(this);

    constructor(name: string) {
      this.name = name;
    }

  }

  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [Article, Product, Category],
      dbName: ':memory:',
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.schema.clear();
    orm.em.clear();
  });

  test('inverse side loading with composite PK owners', async () => {
    const article1 = new Article(1, 100, 'Article 1');
    const article2 = new Article(1, 200, 'Article 2');
    const product1 = new Product(1, 100, 'Product 1');

    const category = new Category('Tech');
    category.articles.add(article1, article2);
    category.products.add(product1);

    orm.em.persist(category);
    await orm.em.flush();
    orm.em.clear();

    const loaded = await orm.em.findOneOrFail(Category, { id: category.id }, {
      populate: ['articles', 'products'],
    });

    expect(loaded.articles).toHaveLength(2);
    expect(loaded.products).toHaveLength(1);

    const loadedArticle1 = loaded.articles.getItems().find(a => a.articleId === 100);
    expect(loadedArticle1).toBeDefined();
    expect(loadedArticle1!.tenantId).toBe(1);
    expect(loadedArticle1!.title).toBe('Article 1');
  });

});

describe('polymorphic to-one with joined strategy', () => {

  @Entity()
  class TargetA {

    @PrimaryKey()
    id!: number;

    @Property()
    valueA!: string;

  }

  @Entity()
  class TargetB {

    @PrimaryKey()
    id!: number;

    @Property()
    valueB!: string;

  }

  @Entity()
  class Owner {

    @PrimaryKey()
    id!: number;

    @Property()
    name!: string;

    @ManyToOne(() => [TargetA, TargetB], { nullable: true })
    target!: TargetA | TargetB | null;

  }

  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TargetA, TargetB, Owner],
      dbName: ':memory:',
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.schema.clear();
    orm.em.clear();

    const targetA = orm.em.create(TargetA, { valueA: 'Value A' });
    const targetB = orm.em.create(TargetB, { valueB: 'Value B' });
    orm.em.create(Owner, { name: 'Owner 1', target: targetA });
    orm.em.create(Owner, { name: 'Owner 2', target: targetB });
    orm.em.create(Owner, { name: 'Owner 3', target: null });

    await orm.em.flush();
    orm.em.clear();
  });

  test('SELECT_IN strategy fires multiple queries for polymorphic relation', async () => {
    const mock = vi.fn();
    const logger = orm.config.getLogger();
    logger.setDebugMode(true);
    logger.log = mock;

    const owners = await orm.em.find(Owner, {}, {
      populate: ['target'],
      strategy: LoadStrategy.SELECT_IN,
      orderBy: { id: QueryOrder.ASC },
    });

    logger.setDebugMode(false);

    expect(owners).toHaveLength(3);
    expect(owners[0].target).toBeInstanceOf(TargetA);
    expect(owners[1].target).toBeInstanceOf(TargetB);
    expect(owners[2].target).toBeNull();

    // SELECT_IN: 1 query for owners + 2 queries (one per target type) = 3
    // Note: There may be additional queries from commit or other operations
    const selectQueries = mock.mock.calls.filter((c: any) => c[1]?.includes('select'));
    expect(selectQueries.length).toBeGreaterThanOrEqual(3);
  });

  // TODO: Implement joined loading for polymorphic relations
  // Currently falls back to SELECT_IN behavior
  test('JOINED strategy currently falls back to SELECT_IN for polymorphic relations', async () => {
    const mock = vi.fn();
    const logger = orm.config.getLogger();
    logger.setDebugMode(true);
    logger.log = mock;

    const owners = await orm.em.find(Owner, {}, {
      populate: ['target'],
      strategy: LoadStrategy.JOINED,
      orderBy: { id: QueryOrder.ASC },
    });

    logger.setDebugMode(false);

    expect(owners).toHaveLength(3);
    expect(owners[0].target).toBeInstanceOf(TargetA);
    expect(owners[1].target).toBeInstanceOf(TargetB);
    expect(owners[2].target).toBeNull();

    // Currently: Falls back to SELECT_IN behavior (at least 3 queries)
    // TODO: Once joined loading is implemented, this should be 1 query
    const selectQueries = mock.mock.calls.filter((c: any) => c[1]?.includes('select'));
    expect(selectQueries.length).toBeGreaterThanOrEqual(3);
  });

});

describe('polymorphic relation with STI target (fixed)', () => {

  test('throws error when polymorphic targets share the same table (STI)', async () => {
    @Entity({
      discriminatorColumn: 'type',
      discriminatorMap: { person: 'Person', employee: 'Employee' },
    })
    class Person {

      @PrimaryKey()
      id!: number;

      @Property()
      name!: string;

    }

    @Entity({ discriminatorValue: 'employee' })
    class Employee extends Person {

      @Property()
      department!: string;

    }

    @Entity()
    class Task {

      @PrimaryKey()
      id!: number;

      @Property()
      title!: string;

      // This is disallowed: Person and Employee share the same table
      // Use separate @ManyToOne(() => Person) properties instead
      @ManyToOne(() => [Person, Employee], { nullable: true })
      assignee!: Person | Employee | null;

    }

    await expect(
      MikroORM.init({
        entities: [Person, Employee, Task],
        dbName: ':memory:',
        metadataProvider: ReflectMetadataProvider,
      }),
    ).rejects.toThrow(/incompatible polymorphic targets.*both use table 'person'.*Use separate properties/i);
  });

});

describe('invalid discriminator value handling (fixed)', () => {

  @Entity()
  class TypeA {

    @PrimaryKey()
    id!: number;

    @Property()
    value!: string;

  }

  @Entity()
  class TypeB {

    @PrimaryKey()
    id!: number;

    @Property()
    value!: string;

  }

  @Entity()
  class Container {

    @PrimaryKey()
    id!: number;

    @ManyToOne(() => [TypeA, TypeB])
    item!: TypeA | TypeB;

  }

  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TypeA, TypeB, Container],
      dbName: ':memory:',
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.schema.clear();
    orm.em.clear();
  });

  test('throws error when hydrating invalid discriminator value', async () => {
    const conn = orm.em.getConnection();
    await conn.execute(`INSERT INTO type_a (id, value) VALUES (1, 'A')`);
    await conn.execute(`INSERT INTO container (id, item_type, item_id) VALUES (1, 'invalid_type', 1)`);

    await expect(
      orm.em.findOneOrFail(Container, { id: 1 }),
    ).rejects.toThrow(/discriminator|unknown|invalid/i);
  });

});

describe('ChangeSetComputer with polymorphic relations (fixed)', () => {

  @Entity()
  class Target {

    @PrimaryKey()
    id!: number;

    @Property()
    name!: string;

  }

  @Entity()
  class Target2 {

    @PrimaryKey()
    id!: number;

    @Property()
    name!: string;

  }

  @Entity()
  class Parent {

    @PrimaryKey()
    id!: number;

    @ManyToOne(() => [Target, Target2])
    poly!: Target | Target2;

  }

  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [Target, Target2, Parent],
      dbName: ':memory:',
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.schema.clear();
    orm.em.clear();
  });

  test('updating to same target does not create unnecessary changeset', async () => {
    const target = orm.em.create(Target, { name: 'Target' });
    const parent = orm.em.create(Parent, { poly: target });
    await orm.em.flush();

    // Re-assign the same target - should not create a changeset
    parent.poly = target;

    const uow = orm.em.getUnitOfWork();
    uow.computeChangeSets();
    const changes = uow.getChangeSets();

    const parentChanges = changes.filter(cs => cs.entity === parent);
    expect(parentChanges).toHaveLength(0);
  });

});
