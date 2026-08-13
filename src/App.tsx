import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { CreateGamePage } from './pages/CreateGamePage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { LobbyPage } from './pages/LobbyPage'
import { MyGamesPage } from './pages/MyGamesPage'
import { PublicRoomsPage } from './pages/PublicRoomsPage'

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-neutral-950 text-neutral-100">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreateGamePage />} />
          <Route path="/games" element={<MyGamesPage />} />
          <Route path="/public" element={<PublicRoomsPage />} />
          <Route path="/lobby/:roomCode" element={<LobbyPage />} />
          <Route path="/game/:roomCode" element={<GamePage />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
