# Đinh Linh pass đồ - Vercel + Firebase

## Cách deploy lên Vercel

1. Giải nén file zip này.
2. Upload toàn bộ thư mục lên GitHub.
3. Vào Vercel > Add New Project > Import repo GitHub.
4. Trong Vercel > Project Settings > Environment Variables, thêm các biến giống file `.env.example`.
5. Deploy.

## Trang sử dụng

- Trang khách: `/`
- Trang admin: `/#admin`
- Mã admin mặc định: `123456` hoặc giá trị bạn đặt trong `VITE_ADMIN_PIN`

## Firebase cần bật

Vào Firebase Console:

1. Build > Firestore Database
2. Create database
3. Start in test mode để thử trước

## Firestore rules test tạm thời

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{id} {
      allow read, write: if true;
    }

    match /orders/{id} {
      allow read, write: if true;
    }

    match /settings/{id} {
      allow read, write: if true;
    }
  }
}
```

Lưu ý: Rules này chỉ để test. Khi bán thật nên khóa admin bằng Authentication / Cloud Functions.
