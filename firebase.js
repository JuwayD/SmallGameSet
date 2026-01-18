// Initialize Firebase
// firebase.js
import { getApps, initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDv0VmnnAlX4fZtnVJ8Mf-2dsGzowy60Lw",
  authDomain: "smallgameset.firebaseapp.com",
  projectId: "smallgameset",
  storageBucket: "smallgameset.firebasestorage.app",
  messagingSenderId: "490012992273",
  appId: "1:490012992273:web:8f17b4a56369afcd3b62b0",
  measurementId: "G-NP569BC1HD",
  databaseURL:"https://smallgameset-default-rtdb.asia-southeast1.firebasedatabase.app"
};
let _db;

export function getDb() {
  // web 预渲染/某些环境没有 window，直接不初始化
  if (typeof window === "undefined") return null;

  if (_db) return _db;

  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  _db = getDatabase(app);
  return _db;
}