const express = require('express');
const { asyncHandler } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');
const { authRouter, setAuth } = require('./authRouter.js');

const userRouter = express.Router();

userRouter.docs = [
  {
    method: 'GET',
    path: '/api/user/me',
    requiresAuth: true,
    description: 'Get authenticated user',
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
  },
  {
    method: 'PUT',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Update user',
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字", "email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
  //here is where i added the necessary backend logic for the new user listing feature
  {
    method: 'GET',
    path: '/api/user?page=0&limit=10&name=*',
    requiresAuth: true,
    description: 'Gets a paginated list of users (admin only)',
    example: `curl -X GET 'localhost:3000/api/user?page=0&limit=10&name=*' -H 'Authorization: Bearer tttttt'`,
    response: { users: [{ id: 1, name: 'Pizza Diner', email: 'd@jwt.com', roles: [{ role: 'diner' }] }], more: false },
  },
  {
    method: 'DELETE',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Deletes a user (admin only)',
    example: `curl -X DELETE localhost:3000/api/user/2 -H 'Authorization: Bearer tttttt'`,
    response: { message: 'user deleted' },
  },
];

// getUser
userRouter.get(
  '/me',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  })
);

// updateUser
userRouter.put(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const userId = Number(req.params.userId);
    const user = req.user;
    if (user.id !== userId && !user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }

    const updatedUser = await DB.updateUser(userId, name, email, password);
    const auth = await setAuth(updatedUser);
    res.json({ user: updatedUser, token: auth });
  })
);

// deleteUser
userRouter.delete(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'invalid user id' });
    }
    await DB.deleteUser(userId);
    res.json({ message: 'user deleted' });
  })
);

// listUsers
userRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }
    const page = req.query.page === undefined ? 0 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
    const name = typeof req.query.name === 'string' ? req.query.name : '*';
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ message: 'page must be a non-negative integer and limit must be between 1 and 100' });
    }
    const result = await DB.getUsers(page, limit, name);
    res.json(result);
  })
);

module.exports = userRouter;
