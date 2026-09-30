const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

const suffix = Date.now().toString(36);
const adminCredentials = { name: `test admin ${suffix}`, email: `admin-${suffix}@test.com`, password: 'admin-password' };
const dinerCredentials = { name: `test diner ${suffix}`, email: `diner-${suffix}@test.com`, password: 'diner-password' };
const franchiseeCredentials = { name: `test franchisee ${suffix}`, email: `franchisee-${suffix}@test.com`, password: 'franchisee-password' };
let adminUser;
let adminToken;
let dinerUser;
let dinerToken;
let franchiseeUser;
let franchiseeToken;
let franchiseId;
let storeId;
let menuItem;

beforeAll(async () => {
  const menu = await DB.getMenu();
  if (!menu.some((item) => item.title === 'Pepperoni')) {
    await DB.addMenuItem({ title: 'Pepperoni', description: 'Spicy treat', image: 'pizza2.png', price: 0.0042 });
  }

  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
});

async function login(credentials) {
  const response = await request(app).put('/api/auth').send(credentials);
  expect(response.status).toBe(200);
  return response.body;
}

beforeAll(async () => {
  adminUser = await DB.addUser({ ...adminCredentials, roles: [{ role: Role.Admin }] });
  dinerUser = await DB.addUser({ ...dinerCredentials, roles: [{ role: Role.Diner }] });
  franchiseeUser = await DB.addUser({ ...franchiseeCredentials, roles: [{ role: Role.Diner }] });

  adminToken = (await login(adminCredentials)).token;
  dinerToken = (await login(dinerCredentials)).token;
  franchiseeToken = (await login(franchiseeCredentials)).token;

  menuItem = (await DB.getMenu()).find((item) => item.title === 'Pepperoni');

  const franchiseResponse = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `test franchise ${suffix}`, admins: [{ email: franchiseeCredentials.email }] });
  expect(franchiseResponse.status).toBe(200);
  franchiseId = franchiseResponse.body.id;

  const storeResponse = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `test store ${suffix}` });
  expect(storeResponse.status).toBe(200);
  storeId = storeResponse.body.id;
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const user = {
    name: testUser.name,
    email: testUser.email,
    roles: [{ role: 'diner' }],
  };
  expect(loginRes.body.user).toMatchObject(user);
});


test('registered user can get a pepperoni pizza from the menu', async () => {
  const menuRes = await request(app).get('/api/order/menu').set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Pepperoni' })]));
});

test('registration requires a name, email, and password', async () => {
  const registerRes = await request(app).post('/api/auth').send({ email: 'missing-fields@test.com' });

  expect(registerRes.status).toBe(400);
  expect(registerRes.body).toEqual({ message: 'name, email, and password are required' });
});

test('logout revokes the registered user token', async () => {
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body).toEqual({ message: 'logout successful' });

  const ordersRes = await request(app).get('/api/order').set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(ordersRes.status).toBe(401);
  expect(ordersRes.body).toEqual({ message: 'unauthorized' });
});

test('serves the root, documentation, and unknown endpoint responses', async () => {
  const rootResponse = await request(app).get('/');
  expect(rootResponse.status).toBe(200);
  expect(rootResponse.body.message).toBe('welcome to JWT Pizza');

  const docsResponse = await request(app).get('/api/docs');
  expect(docsResponse.status).toBe(200);
  expect(docsResponse.body.endpoints.length).toBeGreaterThan(0);

  const unknownResponse = await request(app).get('/not-an-endpoint');
  expect(unknownResponse.status).toBe(404);
  expect(unknownResponse.body).toEqual({ message: 'unknown endpoint' });
});

test('rejects invalid credentials and protects authenticated endpoints', async () => {
  const loginResponse = await request(app).put('/api/auth').send({ email: 'missing@test.com', password: 'wrong' });
  expect(loginResponse.status).toBe(404);

  const missingTokenResponse = await request(app).get('/api/user/me');
  expect(missingTokenResponse.status).toBe(401);

  const invalidTokenResponse = await request(app).get('/api/user/me').set('Authorization', 'Bearer invalid-token');
  expect(invalidTokenResponse.status).toBe(401);
});

test('supports authenticated user endpoints and authorization checks', async () => {
  const meResponse = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerToken}`);
  expect(meResponse.status).toBe(200);
  expect(meResponse.body.email).toBe(dinerCredentials.email);

  const listResponse = await request(app).get('/api/user').set('Authorization', `Bearer ${adminToken}`);
  expect(listResponse.status).toBe(200);
  expect(listResponse.body).toEqual({ message: 'not implemented', users: [], more: false });

  const deleteResponse = await request(app)
    .delete(`/api/user/${dinerUser.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(deleteResponse.status).toBe(200);

  const forbiddenResponse = await request(app)
    .put(`/api/user/${adminUser.id}`)
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: 'not allowed' });
  expect(forbiddenResponse.status).toBe(403);

  const updateResponse = await request(app)
    .put(`/api/user/${dinerUser.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `updated diner ${suffix}`, email: dinerCredentials.email, password: 'updated-password' });
  expect(updateResponse.status).toBe(200);
  expect(updateResponse.body.user.name).toBe(`updated diner ${suffix}`);
  dinerToken = updateResponse.body.token;
});

test('supports menu and order endpoints', async () => {
  const addMenuResponse = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: `Test item ${suffix}`, description: 'Test description', image: 'test.png', price: 0.01 });
  expect(addMenuResponse.status).toBe(200);
  expect(addMenuResponse.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: `Test item ${suffix}` })]));

  const forbiddenMenuResponse = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ title: 'Unauthorized item', description: 'Not allowed', image: 'no.png', price: 0.01 });
  expect(forbiddenMenuResponse.status).toBe(403);

  const ordersBeforeResponse = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
  expect(ordersBeforeResponse.status).toBe(200);
  expect(ordersBeforeResponse.body.dinerId).toBe(dinerUser.id);

  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ reportUrl: 'https://example.test/report', jwt: 'factory-jwt' }),
  }));
  try {
    const orderResponse = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ franchiseId, storeId, items: [{ menuId: menuItem.id, description: menuItem.description, price: menuItem.price }] });
    expect(orderResponse.status).toBe(200);
    expect(orderResponse.body.jwt).toBe('factory-jwt');
  } finally {
    global.fetch = originalFetch;
  }

  const ordersAfterResponse = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
  expect(ordersAfterResponse.status).toBe(200);
  expect(ordersAfterResponse.body.orders.length).toBeGreaterThan(0);
  expect(ordersAfterResponse.body.orders[0].items.length).toBeGreaterThan(0);

  const failedFetch = global.fetch;
  global.fetch = jest.fn(async () => ({
    ok: false,
    json: async () => ({ reportUrl: 'https://example.test/failed-report' }),
  }));
  try {
    const failedOrderResponse = await request(app)
      .post('/api/order')
      .set('Authorization', `Bearer ${dinerToken}`)
      .send({ franchiseId, storeId, items: [{ menuId: menuItem.id, description: menuItem.description, price: menuItem.price }] });
    expect(failedOrderResponse.status).toBe(500);
    expect(failedOrderResponse.body.message).toBe('Failed to fulfill order at factory');
  } finally {
    global.fetch = failedFetch;
  }
});

test('supports franchise listing and franchise authorization', async () => {
  const publicResponse = await request(app).get('/api/franchise').query({ name: `test franchise ${suffix}` });
  expect(publicResponse.status).toBe(200);
  expect(publicResponse.body.franchises).toEqual(expect.arrayContaining([expect.objectContaining({ id: franchiseId })]));

  const adminResponse = await request(app)
    .get('/api/franchise')
    .query({ name: `test franchise ${suffix}` })
    .set('Authorization', `Bearer ${adminToken}`);
  expect(adminResponse.status).toBe(200);
  expect(adminResponse.body.franchises[0].admins.length).toBeGreaterThan(0);

  const franchiseeResponse = await request(app)
    .get(`/api/franchise/${franchiseeUser.id}`)
    .set('Authorization', `Bearer ${franchiseeToken}`);
  expect(franchiseeResponse.status).toBe(200);
  expect(franchiseeResponse.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: franchiseId })]));

  const dinerResponse = await request(app)
    .get(`/api/franchise/${dinerUser.id}`)
    .set('Authorization', `Bearer ${dinerToken}`);
  expect(dinerResponse.status).toBe(200);
  expect(dinerResponse.body).toEqual([]);

  const forbiddenCreateResponse = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: `forbidden franchise ${suffix}`, admins: [] });
  expect(forbiddenCreateResponse.status).toBe(403);

  const invalidAdminResponse = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `invalid franchise ${suffix}`, admins: [{ email: 'unknown@test.com' }] });
  expect(invalidAdminResponse.status).toBe(404);
});

test('supports creating and deleting stores and franchises', async () => {
  const forbiddenStoreResponse = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ name: 'unauthorized store' });
  expect(forbiddenStoreResponse.status).toBe(403);

  const temporaryFranchiseResponse = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `temporary franchise ${suffix}`, admins: [{ email: franchiseeCredentials.email }] });
  expect(temporaryFranchiseResponse.status).toBe(200);
  const temporaryFranchiseId = temporaryFranchiseResponse.body.id;

  const temporaryStoreResponse = await request(app)
    .post(`/api/franchise/${temporaryFranchiseId}/store`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'temporary store' });
  expect(temporaryStoreResponse.status).toBe(200);

  const deleteStoreResponse = await request(app)
    .delete(`/api/franchise/${temporaryFranchiseId}/store/${temporaryStoreResponse.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(deleteStoreResponse.status).toBe(200);

  const deleteFranchiseResponse = await request(app).delete(`/api/franchise/${temporaryFranchiseId}`);
  expect(deleteFranchiseResponse.status).toBe(200);
  expect(deleteFranchiseResponse.body).toEqual({ message: 'franchise deleted' });
});

test('covers database utility methods', () => {
  expect(DB.getOffset(2, 10)).toBe(10);
  expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
  expect(DB.getTokenSignature('not-a-jwt')).toBe('');
});
