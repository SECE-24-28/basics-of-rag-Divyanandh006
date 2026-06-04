const BASE_URL = 'http://localhost:3002/api';

let onAuthErrorCallback = null;

export const setAuthErrorCallback = (callback) => {
  onAuthErrorCallback = callback;
};

const getHeaders = () => {
  const headers = {
    'Content-Type': 'application/json',
  };
  const token = localStorage.getItem('token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

const handleResponse = async (response) => {
  if (response.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (onAuthErrorCallback) {
      onAuthErrorCallback();
    }
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'Unauthorized. Session expired.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error ? (data.details ? `${data.error} (${data.details})` : data.error) : 'Something went wrong';
    throw new Error(message);
  }
  return data;
};

export const api = {
  // Auth API
  async register(name, email, password) {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, email, password }),
    });
    return handleResponse(res);
  },

  async verify(email, code) {
    const res = await fetch(`${BASE_URL}/auth/verify`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email, code }),
    });
    return handleResponse(res);
  },

  async login(email, password) {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await handleResponse(res);
    if (data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    }
    return data;
  },

  async resendVerification(email) {
    const res = await fetch(`${BASE_URL}/auth/resend-verification`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email }),
    });
    return handleResponse(res);
  },

  // Chats API
  async getChats() {
    const res = await fetch(`${BASE_URL}/chats`, {
      method: 'GET',
      headers: getHeaders(),
    });
    return handleResponse(res);
  },

  async createChat(title) {
    const res = await fetch(`${BASE_URL}/chats`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ title }),
    });
    return handleResponse(res);
  },

  async renameChat(id, title) {
    const res = await fetch(`${BASE_URL}/chats/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ title }),
    });
    return handleResponse(res);
  },

  async deleteChat(id) {
    const res = await fetch(`${BASE_URL}/chats/${id}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
    return handleResponse(res);
  },

  // Messages API
  async getMessages(chatId) {
    const res = await fetch(`${BASE_URL}/messages/${chatId}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    return handleResponse(res);
  },

  async sendMessage(chatId, content) {
    const res = await fetch(`${BASE_URL}/messages/${chatId}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ content }),
    });
    return handleResponse(res);
  },

  // Files RAG API
  async getFiles(chatId) {
    const res = await fetch(`${BASE_URL}/chats/${chatId}/files`, {
      method: 'GET',
      headers: getHeaders(),
    });
    return handleResponse(res);
  },

  async uploadFile(chatId, file) {
    const formData = new FormData();
    formData.append('file', file);

    const headers = {};
    const token = localStorage.getItem('token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${BASE_URL}/chats/${chatId}/files`, {
      method: 'POST',
      headers,
      body: formData,
    });
    return handleResponse(res);
  },

  async deleteFile(chatId, fileId) {
    const res = await fetch(`${BASE_URL}/chats/${chatId}/files/${fileId}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
    return handleResponse(res);
  },
};
