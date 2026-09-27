const request = require('supertest');
const app = require('../service');


// async function createAdminUser() {
//   let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
//   user.name = randomName();
//   user.email = user.name + '@admin.com';

//   await DB.addUser(user);
//   user.password = 'toomanysecrets';

//   return user;
// }


const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const { password, ...user } = { ...testUser, roles: [{ role: 'diner' }] };
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
